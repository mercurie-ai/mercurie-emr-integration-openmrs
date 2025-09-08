import axios from 'axios';
import dotenv from 'dotenv';
import { components } from './emr-api-types';
import { convertKeysToSnakeCase, jsonToMarkdown, type KeysToTitleCase } from './utils';

dotenv.config();

const {
    OPENMRS_REST_BASE_URL,
    OPENMRS_FHIR_BASE_URL, 
    OPENMRS_USERNAME, 
    OPENMRS_PASSWORD,
    OPENMRS_DEFAULT_LOCATION_UUID,
    OPENMRS_DEFAULT_PRACTITIONER_UUID,
} = process.env;

const requiredEnvVars = [
    'OPENMRS_REST_BASE_URL',
    'OPENMRS_FHIR_BASE_URL', 
    'OPENMRS_USERNAME', 
    'OPENMRS_PASSWORD',
    'OPENMRS_DEFAULT_LOCATION_UUID',
    'OPENMRS_DEFAULT_PRACTITIONER_UUID',
];

const encounterVisitTypes = {
    "OPD Visit": "287463d3-2233-4c69-9851-5841a1f5e109",
    "Facility Visit": "7b0f5697-27e3-40c4-8bae-f4049abfb4ed",
    "Home Visit": "d66e9fe0-7d51-4801-a550-5d462ad1c944",
}

const encounterNoteTypes = {
    "Visit Note": "d7151f82-c1f3-4152-a605-2f9ea7414a79",
}

const encounterOrderTypes = {
    "Order": "39da3525-afe4-45ff-8977-c53b7b359158",
}

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
    throw new Error(
        `Missing required OpenMRS FHIR environment variables. Please check your .env file. Missing: ${missingEnvVars.join(', ')}`
    );
}

// --- Axios instance for the FHIR API ---
const openmrsFhirApi = axios.create({
    baseURL: OPENMRS_FHIR_BASE_URL,
    auth: {
        username: OPENMRS_USERNAME!,
        password: OPENMRS_PASSWORD!,
    },
    headers: {
        'Content-Type': 'application/fhir+json;charset=utf-8',
        'Accept': 'application/fhir+json',
    }
});


// --- Axios instance for the legacy OpenMRS REST API ---
const openmrsRestApi = axios.create({
    baseURL: OPENMRS_REST_BASE_URL,
    auth: {
        username: OPENMRS_USERNAME!,
        password: OPENMRS_PASSWORD!,
    },
    headers: {
        'Content-Type': 'application/json',
    }
});

// --- Use the imported types ---
type PatientDetails = components['schemas']['PatientDetails'];
type EncounterDetails = components['schemas']['EncounterDetails'];
type PostNoteForm = components['schemas']['PostNoteForm'];
type MedicationOrderFromSchema = components['schemas']['MedicationOrder']

// --- Define the structure for a single diagnosis ---
type Diagnosis = {
    diagnosis: string;
    certainty: 'Confirmed' | 'Provisional';
    rank: "Primary" | "Secondary"
};

// the template used on Mercurie should have these fields 
type Notes = {
    "Clinical Note": any,
    "Diagnoses": TitleCaseDiagnosis[],
    "Medications": TitleCaseMedicationOrder[],
}

// make the additional properties explicit
interface MedicationOrder extends MedicationOrderFromSchema {
    dose: number;
    dose_unit: string;
    route: string;
    frequency: string;
    patient_instructions: string;
    prn_reason: string;
    duration: number;
    duration_unit: string;
    dispense_quantity: number;
    dispense_unit: string;
    refills: number;
    indication: string;
};


type TitleCaseMedicationOrder = KeysToTitleCase<MedicationOrder>;
type TitleCaseDiagnosis = KeysToTitleCase<Diagnosis>;

// --- Data Transformation Functions ---

function capitalizeFirstLetter(str) {
  if (typeof str !== 'string' || str.length === 0) {
    return str; // Handle empty or non-string inputs
  }
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Transforms a FHIR Patient resource into the format expected by the adapter's API.
 */
const transformPatient = (patient: any): PatientDetails => ({
    id: patient.id, // FHIR resources have a top-level 'id'
    display_name: patient.name?.[0]?.text || 'No Name Provided',
    display_id: patient.identifier?.[0]?.value || '',
    display_gender: capitalizeFirstLetter(patient.gender as string),
    display_birthdate: patient.birthDate, // FHIR uses YYYY-MM-DD format
});

/**
 * Transforms a FHIR Encounter resource into the format expected by the adapter's API.
 * 
 */
// Internally, we'll call this a "Visit" to match the OpenMRS UI concept.
const transformVisit = (fhirEncounter: any): EncounterDetails => ({
    id: fhirEncounter.id,
    display_name: (fhirEncounter.type?.[0]?.coding?.[0]?.display + " - " + fhirEncounter.location?.[0]?.location?.display),
    date: fhirEncounter.period?.end?.split('T')[0],
});


// --- API Service Functions ---

export const getPatients = async (): Promise<PatientDetails[]> => {
    try {
        // A FHIR search operation on the /Patient endpoint
        const patients = await getAllFhirQueryResults('/Patient?_summary=true');
        // FHIR search results are in a 'Bundle' resource, within the 'entry' array
        return patients?.map((entry: any) => transformPatient(entry.resource)) || [];
    } catch (error) {
        console.error("Error fetching FHIR Patients:", error);
        throw new Error("Failed to fetch patients from OpenMRS FHIR endpoint.");
    }
};

export const getPatientEncounters = async (patientId: string): Promise<EncounterDetails[]> => {
    try {
        // Search for "visit" encounters related to a specific patient
        const encounters = await getAllFhirQueryResults(`/Encounter?patient=${patientId}&type=${Object.values(encounterVisitTypes).join(",")}&_sort=-date`);
        return encounters?.map((entry: any) => transformVisit(entry.resource)) || [];
    } catch (error) {
        console.error(`Error fetching FHIR Encounters for patient ${patientId}:`, error);
        throw new Error("Failed to fetch patient encounters from OpenMRS FHIR endpoint.");
    }
};


/**
 * Handles posting a note: either creates a new encounter and note,
 * or updates an existing one if an encounter_id is provided.
 */
export const postNote = async (noteData: PostNoteForm): Promise<string> => {
    const { encounter_id, patient_id, note_title } = noteData;

    if ("notes_json" in noteData) {
        const notes = (noteData.notes_json as Notes)['Clinical Note'];

        const notesMarkdown = typeof(notes) == "string" ? notes : jsonToMarkdown(notes);

        const diagnoses = (noteData.notes_json as Notes)['Diagnoses'].map(m => convertKeysToSnakeCase(m));
        const medications = (noteData.notes_json as Notes)['Medications'].map(d => convertKeysToSnakeCase(d));

        if (encounter_id) {
            // --- UPDATE WORKFLOW ---
            console.log(`Attempting to update note for existing visit: ${encounter_id}`);
            return await updateVisitNoteAndCreateOrders(patient_id, encounter_id, note_title, notesMarkdown, medications, diagnoses);
        } else {
            // --- CREATE WORKFLOW ---
            console.log(`Attempting to create new visit for patient: ${patient_id}`);
            if (!patient_id) throw new Error("patient_id is required to create a new encounter.");
            return await createVisitAndOrders(patient_id, note_title, notesMarkdown, medications, diagnoses);
        }
    } else {
        throw(new Error("Expecting notes in structured JSON format."))
    }
};


/**
 * Generates the patient summary 
 */
export const getPatientSummary = async (patientId: string): Promise<string | null> => {
    try {
        const [activeConditions, activeMedications] = await Promise.all([
            getActiveConditions(patientId),
            getActiveMedications(patientId),
        ]);


        let markdownString = ``;

        if (activeConditions && activeConditions.length > 0) {
            markdownString += markdownString.length > 0 ? `\n---\n\n## Active Conditions\n` : `## Active Conditions\n`;
            activeConditions.forEach(cond => {
                markdownString += `- *${cond.name}*\n`;
            });
        }

        if (activeMedications && activeMedications.length > 0) {
            markdownString += markdownString.length > 0 ? `\n---\n\n## Active Medications\n` : `## Active Medications\n`;
            activeMedications.forEach(med => {
                markdownString += `- *${med.name}*\n`;
                markdownString += `  - Started: ${new Date(med.start_time).toDateString()}\n`;
                markdownString += `  - Dose: ${med.dose} ${med.dose_unit} - ${med.route} - ${med.frequency} - for ${med.duration} ${med.duration_unit} - ${med.dosage_instruction}\n`;
                markdownString += `  - Dispense: ${med.dispense_quantity} ${med.dispense_unit} - ${med.refills} refills\n`;
            });
        }

        return markdownString;

    } catch (error: any) {
        console.error(`Error fetching summary for FHIR patient ${patientId}:`, error.response?.data || error.message);
        throw new Error("Failed to fetch patient summary from OpenMRS FHIR endpoint.");
    }
};

/**
 * Retrieves the note (Observation) for a given Visit (Encounter).
 */
export const getEncounterNote = async (visitId: string): Promise<string | null> => {
    try {
        // Fetch 'visit note' encounter
        const visitNoteEncounter = await findChildNoteEncounter(visitId);
        const visitNoteEncounterId = visitNoteEncounter?.id;

        // Fetch Observation (note text)
        // There should only be one observation linked to the visit note
        // And this observation contains the clinical notes
        const clinicalNoteResponse = visitNoteEncounterId ?
            (await openmrsFhirApi.get(`/Observation?encounter=${visitNoteEncounterId}`))
        :
            null;

        const clinicalNote = clinicalNoteResponse?.data.entry?.[0]?.resource?.valueString || ""

        let markdownString = ""

        markdownString += `## Diagnoses\n`;
        
        if (visitNoteEncounterId) {
            const diagnoses = await getVisitDiagnoses(visitNoteEncounterId);
            if (diagnoses && diagnoses.length > 0) {
                diagnoses.forEach(d => {
                    markdownString += `- *${d.diagnosis}* - ${d.rank} - ${d.certainty}\n`
                })
                markdownString += "\n"
            } else {
                markdownString += 'No diagnoses recorded.\n\n';
            }
        } else {
            markdownString += 'No diagnoses recorded.\n\n';
        }

        markdownString += `## Clinical Note\n${clinicalNote || 'No clinical note recorded.'}\n`;

        return markdownString;

    } catch (error: any) {
        console.error(`Error fetching note for FHIR visit ${visitId}:`, error.response?.data || error.message);
        throw new Error("Failed to fetch encounter note from OpenMRS FHIR endpoint.");
    }
};


/**
 * Finds the child "Visit Note" encounter attached to a parent "Visit" encounter.
 * @private
 */
async function findChildNoteEncounter(parentVisitId: string): Promise<any | null> {
    // OpenMRS doesn't allow encounter query using part-of key
    try {
        // Step 1: Fetch the parent encounter to find its patient.
        const parentVisitResponse = await openmrsFhirApi.get(`/Encounter/${parentVisitId}`);
        const patientReference = parentVisitResponse.data?.subject?.reference; // e.g., "Patient/uuid"

        if (!patientReference) {
            console.error(`Could not determine patient for parent visit ${parentVisitId}`);
            return null;
        }
        const patientId = patientReference.split('/')[1];

        // Step 2: Fetch all "Visit Note" encounters for that patient.
        const allNoteEncounters = await getAllFhirQueryResults(`/Encounter?patient=${patientId}&type=${Object.values(encounterNoteTypes).join(",")}`);
        if (!allNoteEncounters || allNoteEncounters.length === 0) {
            return null; // No "Visit Note" encounters found for this patient.
        }

        // Step 3: Loop through the results to find the one linked to our parent visit.
        const targetReference = `Encounter/${parentVisitId}`;
        const childEncounterEntry = allNoteEncounters.find((entry: any) => 
            entry.resource?.partOf?.reference === targetReference
        );

        return childEncounterEntry?.resource || null;

    } catch (error: any) {
        console.error(`Error finding child note encounter for parent ${parentVisitId}:`, error.response?.data || error.message);
        throw new Error(`Failed to find child note for visit ${parentVisitId}.`);
    }
}

/**
 * Finds the child "Order" encounters attached to a parent "Visit" encounter.
 * @private
 */
async function findChildOrderEncounters(parentVisitId: string): Promise<any[]> {
    try {
        const parentVisitResponse = await openmrsFhirApi.get(`/Encounter/${parentVisitId}`);
        const patientReference = parentVisitResponse.data?.subject?.reference;
        if (!patientReference) return [];
        const patientId = patientReference.split('/')[1];

        const allOrderEncounters = await getAllFhirQueryResults(`/Encounter?patient=${patientId}&type=${Object.values(encounterOrderTypes).join(',')}`);
        
        if (allOrderEncounters.length === 0) return [];

        const targetReference = `Encounter/${parentVisitId}`;
        const childEncounters = allOrderEncounters
            .filter((entry: any) => entry.resource?.partOf?.reference === targetReference)
            .map((entry: any) => entry.resource);

        return childEncounters;

    } catch (error: any) {
        console.error(`Error finding child order encounters for parent ${parentVisitId}:`, error.response?.data || error.message);
        throw new Error(`Failed to find child orders for visit ${parentVisitId}.`);
    }
}


/**
 * Creates a new Encounter and associated note resources.
 * @private
 */
async function createVisitAndOrders(patientId: string, _noteTitle: string, notes: string, medicationOrders: MedicationOrder[], diagnoses?: Diagnosis[]): Promise<string> {
    const now = new Date().toISOString();

    // STEP 1: Create the Visit (Encounter)
    const visitResource = {
        resourceType: "Encounter",
        status: "finished",
        class: { 
            system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", 
            code: "AMB", // ambulatory
        },
        type: [
            { 
                coding: [
                    {
                        system: "http://fhir.openmrs.org/code-system/visit-type",
                        code: encounterVisitTypes['OPD Visit'],
                        display: "OPD Visit",
                    }
                ]
            }
        ],
        subject: { 
            reference: `Patient/${patientId}` 
        },
        period: { 
            start: now 
        },
        location: [
            {
                location: {
                    reference: `Location/${OPENMRS_DEFAULT_LOCATION_UUID}`
                }
            }
        ]
    };

    let newVisitId: string;

    try {
        console.log("STEP 1: Creating Visit (Encounter)...");
        const visitResponse = await openmrsFhirApi.post('/Encounter', visitResource);
        newVisitId = visitResponse.data.id;
        console.log(`-> Success! Created Visit with ID: ${newVisitId}`);
    } catch (error: any) {
        console.error("-> FAILURE at Step 1: Could not create Visit.", error.response?.data || error.message);
        throw new Error("Failed to create the base Visit in OpenMRS.");
    }

    // --- STEP 2: Create the child "Visit Note" Encounter ---
    console.log("STEP 2: Creating child 'Visit Note' Encounter...");
    let newNoteEncounterId: string;
    try {
        newNoteEncounterId = (await createVisitNoteEncounter(patientId, newVisitId)).id;
    } catch (error: any) {
        console.error("-> FAILURE at Step 2: Could not create 'Visit Note' Encounter.", error.response?.data || error.message);
        throw new Error("Created the parent Visit, but failed to create the child note encounter.");
    }
    

    // --- STEP 3: Create the Observation and link to the "Visit Note" Encounter ---
    const noteObservationResource = {
        resourceType: "Observation",
        status: "final",
        code: { 
            coding: [
                { 
                    system: "https://cielterminology.org", 
                    code: "162169", 
                    display: "Text of encounter note"
                }
            ] 
        },
        subject: { 
            reference: `Patient/${patientId}` 
        },
        encounter: { 
            reference: `Encounter/${newNoteEncounterId}` 
        }, 
        valueString: notes,
        effectiveDateTime: now,
    };

    try {
        console.log("STEP 3: Creating and linking Note (Observation)...");
        await openmrsFhirApi.post('/Observation', noteObservationResource);
        console.log(`-> Success! Linked Observation to Visit Note ${newNoteEncounterId}`);
    } catch (error: any) {
        console.error("-> FAILURE at Step 3: Could not create Observation.", error.response?.data || error.message);
        throw new Error("Created Visit and Note Encounter, but failed to link the clinical note observation.");
    }

    // --- STEP 4: Create Medication Orders ---
    if (medicationOrders && medicationOrders.length > 0) {
        console.log("STEP 4: Creating Medication Orders via legacy REST API...");
        const parentVisitUuid = newVisitId; 

        for (const order of medicationOrders) {
            await createDrugOrder(patientId, parentVisitUuid, order);
        }
        console.log("-> Success! Finished creating medication orders.");
    }

    // --- STEP 5: Process Diagnoses ---
    if (diagnoses && diagnoses.length > 0) {
        await processDiagnoses(patientId, newVisitId, diagnoses);
    }

    return newVisitId; 
}


/**
 * Updates an existing Encounter and its associated note (Binary) resource.
 * @private
 */
async function updateVisitNoteAndCreateOrders(patientId: string, visitId: string, _noteTitle: string, notes: string, medicationOrders: MedicationOrder[], diagnoses?: Diagnosis[]): Promise<string> {
    try {
        // --- STEP 1: Find existing child 'Visit Note' Encounter ---
        console.log(`STEP 1: Finding existing child 'Visit Note' Encounter...`);

        const childNoteEncounter = (await findChildNoteEncounter(visitId)) || (await createVisitNoteEncounter(patientId, visitId));
        const childNoteEncounterId = childNoteEncounter?.id;
        
        console.log(`-> Child encounter ID: ${childNoteEncounterId}.`);
        
        // --- STEP 2: Find existing Note Observation ---
        console.log(`STEP 2: Finding existing Note Observation...`);
        
        // Fetch Observation (note text)
        // There should only be one observation linked to the visit note
        // And this observation contains the clinical notes
        const existingNoteResponse = await openmrsFhirApi.get(`/Observation?encounter=${childNoteEncounterId}`);
        const existingNoteObservation = existingNoteResponse.data.entry?.[0]?.resource;
        
        if (existingNoteObservation) {
            console.log(`-> Found existing Observation ${existingNoteObservation.id}. Updating...`);
            const updatedNoteResource = { ...existingNoteObservation, valueString: notes };
            await openmrsFhirApi.put(`/Observation/${existingNoteObservation.id}`, updatedNoteResource);
            console.log(`-> Success! Updated existing Observation.`);
        } else {

             console.log(`-> No existing Observation found. Creating a new one...`);

             const newNoteResource = {
                resourceType: "Observation",
                status: "final",
                code: { 
                    coding: [
                        { 
                            system: "https://cielterminology.org", 
                            code: "162169", 
                            display: "Text of encounter note"
                        }
                    ] 
                },
                subject: { 
                    reference: childNoteEncounter.subject.reference,
                },
                encounter: { 
                    reference: `Encounter/${childNoteEncounterId}` 
                }, 
                valueString: notes,
                effectiveDateTime: new Date().toISOString()
            };

             await openmrsFhirApi.post('/Observation', newNoteResource);
             console.log(`-> Success! Created new Observation for child encounter.`);
        }

        // --- STEP 3: Process Diagnoses ---
        if (diagnoses && diagnoses.length > 0) {
            await processDiagnoses(patientId, visitId, diagnoses);
        }

        // --- STEP 4: Create Medication Orders ---
        if (medicationOrders && medicationOrders.length > 0) {
            console.log("STEP 3: Creating Medication Orders via legacy REST API...");
            for (const order of medicationOrders) {
                await createDrugOrder(patientId, visitId, order);
            }
            console.log("-> Success! Finished creating medication orders.");
        }

        return visitId;
    } catch (error: any) {
        console.error(`-> FAILURE during update for visit ${visitId}:`, error.response?.data || error.message);
        throw new Error(`Failed to update visit/note for visit ${visitId}.`);
    }
}

/**
 * Checks for existing diagnoses by name and creates any that are new for the patient.
 * @private
 */
async function processDiagnoses(patientId: string, visitId: string, diagnoses: Diagnosis[]): Promise<void> {
    console.log("STEP: Processing diagnoses...");
    try {
        // TODO:
        // To update the dignoses, we remove all existing diagnoses and add the new ones
        // we can improve this by adding a diffing logic and not deleting the ones that are unchanged

        const visitNoteEncounter = await findChildNoteEncounter(visitId);
        const visitNoteEncounterId = visitNoteEncounter.id

        // 1. Remove all existing diagnoses
        const existingDiagnoses = await getVisitDiagnoses(visitNoteEncounterId);
        existingDiagnoses.forEach(d => {
            console.log(`-> Delete existing diagnosis: '${d.diagnosis}'`)
            openmrsRestApi.delete(`/patientdiagnoses/${d.uuid}`);
        });

        // 2. Add all the new dignoses
        for (const diagnosis of diagnoses) {
            console.log(`-> Adding new diagnosis: '${diagnosis.diagnosis}'`);
            await postVisitDiagnosis(patientId, visitNoteEncounterId, diagnosis);
            console.log(`   - Success! Created new Condition for '${diagnosis.diagnosis}'.`);
        }

    } catch (error: any) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        console.error(`-> FAILURE during diagnosis processing:`, error.response?.data || error.message);
        throw new Error(`Failed to process diagnoses for patient ${patientId}: ${errorMessage}`);
    }
}


/**
 * Creates a drug order using the OpenMRS legacy REST API.
 * OpenMRS FHIR API does not support drug order creation.
 * @private
 */
async function createDrugOrder(patientUuid: string, visitEncounterUuid: string, orderData: MedicationOrder) {
    try {

        // --- STEP 1: Create Order Encounter ---
        const orderEncounterResource = {
            resourceType: "Encounter",
            status: "finished",
            class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
            type: [{
                coding: [{
                    system: "http://fhir.openmrs.org/code-system/encounter-type",
                    code: encounterOrderTypes["Order"],
                    display: "Order"
                }]
            }],
            subject: { reference: `Patient/${patientUuid}` },
            period: { start: new Date().toISOString() },
            location: [{ location: { reference: `Location/${OPENMRS_DEFAULT_LOCATION_UUID}` } }],
            partOf: { reference: `Encounter/${visitEncounterUuid}` }
        };

        const response = await openmrsFhirApi.post('/Encounter', orderEncounterResource);
        const newOrderEncounterId = response.data.id;
        console.log(`Created new 'Order' encounter: ${newOrderEncounterId}`);

        // --- STEP 2: Create Drug Order using REST API---
        const drugConceptUuid = await getDrugUuid(orderData.name, orderData.strength);

        const orderPayload = {
            type: "drugorder",
            patient: patientUuid,
            encounter: newOrderEncounterId,
            action: "NEW",
            urgency: "ROUTINE",
            careSetting: "6f0c9a92-6f24-11e3-af88-005056821db0",
            orderer: OPENMRS_DEFAULT_PRACTITIONER_UUID,
            drug: drugConceptUuid, 
            dosingType: "org.openmrs.SimpleDosingInstructions", // Use simple dosing
            dose: orderData.dose,
            doseUnits: (await getConceptUuid(orderData.dose_unit)),
            route: (await getConceptUuid(orderData.route)),
            frequency: (await getConceptUuid(orderData.frequency)),
            duration: orderData.duration,
            durationUnits: (await getConceptUuid(orderData.duration_unit)),
            quantity: orderData.dispense_quantity,
            quantityUnits: (await getConceptUuid(orderData.dispense_unit)),
            numRefills: orderData.refills,
            dosingInstructions: orderData.patient_instructions,
            asNeeded: orderData.prn_reason.trim().length > 0,
            asNeededCondition: orderData.prn_reason,
            orderReasonNonCoded: orderData.indication,
        };

        await openmrsRestApi.post('/order', orderPayload);
        console.log(`   - Successfully created legacy REST API Drug Order for '${orderData.name}'`);

    } catch (error: any) {
        console.error(`-> FAILURE: Could not create legacy Drug Order for '${orderData.name}'.`, error.response?.data ? JSON.stringify(error.response?.data, null, 2) : error.message);

        const errorDetail = error.response?.data?.error?.message || error.message;
        if (errorDetail.includes("Concept not found")) {
             console.error("   -> HINT: The error 'Concept not found' likely means the drug name or a unit name could not be resolved to a valid UUID in OpenMRS. You need to implement a concept lookup.");
        }
        throw new Error(`Failed to create Drug Order for ${orderData.name}: ${errorDetail}`);
    }
}


async function createVisitNoteEncounter(patientId: string, visitEncounterId: string): Promise<any> {

    const noteEncounterResource = {
        resourceType: "Encounter",
        status: "finished",
        class: { 
            system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", 
            code: "AMB" 
        },
        type: [
            { 
                coding: [
                    {
                        system: "http://fhir.openmrs.org/code-system/encounter-type",
                        code: encounterNoteTypes["Visit Note"],
                        display: "Visit Note"
                }
                ]
            }
        ],
        subject: { 
            reference: `Patient/${patientId}` 
        },
        period: { 
            start: new Date().toISOString(),
        },
        participant: [
            { 
                individual: 
                { 
                    reference: `Practitioner/${OPENMRS_DEFAULT_PRACTITIONER_UUID}` 
                } 
            }
        ],
        location: [
            { 
                location: 
                { 
                    reference: `Location/${OPENMRS_DEFAULT_LOCATION_UUID}` 
                } 
            }
        ],
        partOf: { 
            reference: `Encounter/${visitEncounterId}` 
        } 
    };

    const noteEncounterResponse = await openmrsFhirApi.post('/Encounter', noteEncounterResource);
    const newNoteEncounter = noteEncounterResponse.data;

    return  newNoteEncounter
}



async function getDrugUuid(name: string, strength: string) {
    const fullName = name + " " + strength;

    try {
        const response = await openmrsRestApi.get(`/drug?q=${encodeURIComponent(name)}`);
        const concept = response.data.results.find(c => c.display.toLowerCase().replaceAll(" ", "") === fullName.toLowerCase().replaceAll(" ", ""));
        if (concept) {
            return concept.uuid;
        }
        throw new Error(`Drug UUID not found for '${fullName}'`);
    } catch (error) {
        console.error(`Error fetching drug UUID for '${fullName}':`, error);
        throw error;
    }
}


async function getConceptUuid(name: string): Promise<string> {
    try {
        const response = await openmrsRestApi.get(`/concept?q=${encodeURIComponent(name)}`);
        const concept = response.data.results.find(c => c.display.toLowerCase() === name.toLowerCase());
        if (concept) {
            return concept.uuid;
        }
        throw new Error(`Concept UUID not found for '${name}'`);
    } catch (error) {
        console.error(`Error fetching concept UUID for '${name}':`, error);
        throw error;
    }
}



/**
 * Get active conditions for the patient
 * @private
 */
const getActiveConditions = async (patientId: string) => {
    const activeConditions = await getAllFhirQueryResults('/Condition?patient=${patientId}&clinical-status=active')
    return (
        activeConditions
            .map((entry: any) => { 
                return {
                    name: entry.resource.code.text,
                }
            })
    )
}


/**
 * Get active medications for the patient
 * @private
 */
const getActiveMedications = async (patientId: string) => {
    const medications = await getAllFhirQueryResults(`/MedicationRequest?patient=${patientId}`)

    // Reverse mapping from FHIR code to our simplified unit
    const reverseDurationUnitMapping: { [key: string]: 'Days' | 'Weeks' | 'Months' } = {
        'd': 'Days', 
        'day': 'Days',
        'wk': 'Weeks', 
        'week': 'Weeks',
        'mo': 'Months', 
        'month': 'Months',
    }

    const activeMedications = medications
        .filter((entry: any) => entry.resource.status == "active")
        .map((entry: any) => {
            const resource = entry.resource;
            const dose = resource.dosageInstruction[0];
            const dispense = resource.dispenseRequest;
            
            return {
                name: resource.medicationCodeableConcept?.text || resource.medicationReference?.display,
                status: resource.status,
                dosage_instruction: dose.text,
                dose: dose.doseAndRate?.[0].doseQuantity.value || "",
                dose_unit: dose.doseAndRate?.[0].doseQuantity.unit || "",
                route: dose.route?.text || "",
                frequency: dose.timing?.code?.text || "",
                duration: dispense.expectedSupplyDuration?.value || dose.timing?.repeat?.duration || 0,
                duration_unit: reverseDurationUnitMapping[dispense.expectedSupplyDuration?.unit] || reverseDurationUnitMapping[dose.timing?.repeat?.durationUnit] || 'Days',
                dispense_quantity: dispense.quantity?.value || 0,
                dispense_unit: dispense.quantity?.unit || 'N/A',
                refills: dispense.numberOfRepeatsAllowed || 0,
                start_time: dispense.validityPeriod.start,
            };
        });
    return activeMedications
}


/**
 * Get lab tests ordered in this visit
 * @private
 */
const _getOrderLabTests = async (visitId: string) => {
    const childOrderEncounters = await findChildOrderEncounters(visitId)
    const orderEncounterIds = childOrderEncounters.map(enc => enc.id).join(',');

    const orderedLabTests = await getAllFhirQueryResults(`/ServiceRequest?encounter=${orderEncounterIds}`)

    return (
        orderedLabTests.map((entry: any) => ({
            name: entry.resource.code.text,
            date: entry.resource.occurrencePeriod.start
        }))
    )
}


/**
 * Get diagnoses for this visit
 * @private
 */
const getVisitDiagnoses = async (visitNoteId: string) => {
    const visitNoteDetails = await openmrsRestApi.get(`/encounter/${visitNoteId}`);
    const diagnoses = visitNoteDetails.data.diagnoses;

    return (
        diagnoses
            .filter(d => d.voided == false)
            .map((d) => {
                return {
                    uuid: d.uuid,
                    diagnosis: d.display,
                    rank: d.rank == 1 ? "Primary" : "Secondary",
                    certainty: capitalizeFirstLetter(d.certainty),
                }
            })
    )
}

/**
 * Add diagnosis for this visit
 * @private
 */
async function postVisitDiagnosis(patientId: string, visitNoteEncounterId: string, diagnosis: Diagnosis) {

    let conceptId: string | null = null
    try {
        conceptId = await getConceptUuid(diagnosis.diagnosis);
    } catch (_err) {}

    if (!conceptId) {
        console.warn(`Coding not found for diagnosis '${diagnosis.diagnosis}'. Saving it non-coded.`)
    }

    const diagnosisPayload = {
        "patient": patientId,
        "diagnosis": conceptId ? { "coded": conceptId } : { "nonCoded": diagnosis.diagnosis },
        "certainty": diagnosis.certainty,
        "rank": diagnosis.rank == "Primary" ? 1 : 0,
        "condition": null,
        "encounter": visitNoteEncounterId,
    }

    openmrsRestApi.post('/patientdiagnoses', diagnosisPayload);
}


/**
 * Add condition for this patient
 * @private
 */
async function _postPatientCondition(patientId: string, diagnosis: Diagnosis) {
    let conceptId = (await getConceptUuid(diagnosis.diagnosis));

    const conditionPayload = {
        "patient": patientId,
        "condition": {
            "coded": conceptId,
        },
        "onsetDate": null,
        "verificationStatus": diagnosis.certainty,
        "clinicalStatus": "ACTIVE",
    }

    openmrsRestApi.post('/condition', conditionPayload);
}


/**
 * Loops over paginated query results and collects them all
 * @private
 */
async function getAllFhirQueryResults(queryUrl: string): Promise<any[]> {
    let url: null | string = queryUrl
    let entries: any[] = []

    do {
        let response = await openmrsFhirApi.get(url)

        entries = [...entries, ...(response.data.entry || [])]

        url = null
        for (const l of response.data.link) {
            if (l.relation == "next") {
                url = l.url
            }
        }
    } while (url != null)

    return entries
}