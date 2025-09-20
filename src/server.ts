// src/server.ts

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { components } from '../src/emr-api-types';
import * as OpenMRSFHIR from './openmrs-api';

// --- Configuration & Setup ---
dotenv.config();
const { PORT, BASE_URL, API_KEY, OPENMRS_FRONTEND_URL } = process.env;
if (!PORT || !BASE_URL || !API_KEY || !OPENMRS_FRONTEND_URL) throw new Error("...");

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- Type Definitions ---
type EndpointsResponse = components['schemas']['EndpointsResponse'];
type PatientListResponse = components['schemas']['PatientListResponse'];
type PostNoteForm = components['schemas']['PostNoteForm'];
type PostNoteResponse = components['schemas']['PostNoteResponse'];
type GetSummaryResponse = components['schemas']['GetSummaryResponse'];
type EncounterListResponse = components['schemas']['EncounterListResponse'];
type GetEncounterNoteResponse = components['schemas']['GetEncounterNoteResponse'];
type GetMedicationTemplatesResponse = components['schemas']['GetMedicationTemplatesResponse']
type MedicationOrder = components['schemas']['MedicationOrder']
type ErrorResponse = components['schemas']['ErrorResponse'];

// --- Middleware ---
const requireApiKey = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

    if (token && token === API_KEY) return next();
    res.status(401).json({ error: 'Unauthorized', message: '...' });
};

// --- API Endpoints ---

// 0. GET /endpoints
app.get('/endpoints', requireApiKey, (req: Request, res: Response<EndpointsResponse>) => {
    console.log(`[${new Date().toISOString()}] GET /endpoints`);
    res.status(200).json({
        get_patients: `${BASE_URL}/patients`,
        post_note: `${BASE_URL}/notes`,
        patient_chart_page: `${OPENMRS_FRONTEND_URL}/patient/:patientId/chart/Patient%20Summary`,
        get_patient_summary: `${BASE_URL}/patient-summary/:patientId`,
        get_patient_encounters: `${BASE_URL}/patients/:patientId/encounters`,
        get_encounter_note: `${BASE_URL}/encounters/:encounterId`,
        get_medication_templates: `${BASE_URL}/med-templates`,
    });
});

// 1. GET /patients
app.get('/patients', requireApiKey, async (req: Request, res: Response<PatientListResponse | ErrorResponse>) => {
    console.log(`[${new Date().toISOString()}] GET /patients`);
    try {
        // Use the FHIR service
        const patients = await OpenMRSFHIR.getPatients();
        res.status(200).json({ patient_lists: [ { list_name: "All Patients", patients } ] });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error', message: (error as Error).message });
    }
});

// 2. POST /notes
app.post('/notes', requireApiKey, async (req: Request<{}, {}, PostNoteForm>, res: Response<PostNoteResponse | ErrorResponse>) => {
    console.log(`[${new Date().toISOString()}] POST /notes request received.`);
    
    try {
        // Call the single "upsert" function that contains the create vs. update logic.
        const encounterId = await OpenMRSFHIR.postNote(req.body);
        res.status(200).json({ encounter_id: encounterId });
    } catch (error) {
        // Provide a more informative error message to the client
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
        console.error("Error in POST /notes:", errorMessage);
        res.status(500).json({ error: 'Internal Server Error', message: errorMessage });
    }
});



// 3. GET /patients/:patientId/encounters
app.get('/patients/:patientId/encounters', requireApiKey, async (req: Request<{ patientId: string }>, res: Response<EncounterListResponse | ErrorResponse>) => {
    const { patientId } = req.params;
    console.log(`[${new Date().toISOString()}] GET /patients/${patientId}/encounters`);
    try {
        // Use the FHIR service
        const encounters = await OpenMRSFHIR.getPatientEncounters(patientId);
        res.status(200).json({ encounters });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error', message: (error as Error).message });
    }
});

// 3. GET /patient-summary/:patientId - To fetch the clinical summary
app.get('/patient-summary/:patientId', requireApiKey, async (req: Request<{ patientId: string }>, res: Response<GetSummaryResponse | ErrorResponse>) => {
    const { patientId } = req.params;
    console.log(`[${new Date().toISOString()}] GET /patient-summary/${patientId}`);
    try {
        const summary = await OpenMRSFHIR.getPatientSummary(patientId);

        if (summary != null) {
            res.status(200).json({ summary_notes: summary });
        } else {
            res.status(404).json({ error: 'Not Found', message: 'No summary found for this patient.' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error', message: (error as Error).message });
    }
});

// 4. GET /encounters/:encounterId
app.get('/encounters/:encounterId', requireApiKey, async (req: Request<{ encounterId: string }>, res: Response<GetEncounterNoteResponse | ErrorResponse>) => {
    const { encounterId } = req.params;
    console.log(`[${new Date().toISOString()}] GET /encounters/${encounterId}`);
    try {
        // Use the FHIR service
        const note = await OpenMRSFHIR.getEncounterNote(encounterId);
        if (note !== null) {
            res.status(200).json({ note });
        } else {
            res.status(404).json({ error: 'Not Found', message: `No note found for encounter ${encounterId}.` });
        }
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error', message: (error as Error).message });
    }
});


// 5. GET /med-templates - To fetch medication order templates
app.get('/med-templates', requireApiKey, (_req: Request, res: Response<GetMedicationTemplatesResponse>) => {
  console.log(`[${new Date().toISOString()}] GET /patients request received.`);

  const responseData: GetMedicationTemplatesResponse = {
    med_templates,
  };

  res.status(200).json(responseData);
});


// --- Start Server ---
app.listen(PORT, () => {
    console.log(`\n🩺 OpenMRS FHIR Adapter is running on ${BASE_URL}`);
    console.log(`   Connected to OpenMRS FHIR at: ${process.env.OPENMRS_FHIR_BASE_URL}`);
    console.log('---------------------------------------------------------');
});



// --- Template Data ---

const med_templates: MedicationOrder[] = [
  {
    name: "Aspirin",
    strength: "81 mg",
    dose: 1,
    dose_unit: "Tablet",
    route: "Oral",
    frequency: "Once daily",
    patient_instructions: "",
    prn: false,
    prn_reason: "",
    duration: 7,
    duration_unit: 'Days',
    dispense_quantity: 7,
    dispense_unit: 'Tablet',
    refills: 0,
    indication: 'Fever'
  },
  {
    name: "Lisinopril",
    strength: "10 mg",
    dose: 1,
    dose_unit: "Tablet",
    route: "Oral",
    frequency: "Once daily",
    patient_instructions: "",
    prn: false,
    prn_reason: "",
    duration: 7,
    duration_unit: 'Days',
    dispense_quantity: 7,
    dispense_unit: 'Tablet',
    refills: 0,
    indication: 'Hypertension'
  },
  {
    name: "Paracetamol",
    strength: "500 mg",
    dose: 1,
    dose_unit: "Tablet",
    route: "Oral",
    frequency: "Twice daily",
    patient_instructions: "Take after meals",
    prn: false,
    prn_reason: "",
    duration: 7,
    duration_unit: 'Days',
    dispense_quantity: 14,
    dispense_unit: 'Tablet',
    refills: 0,
    indication: 'Fever'
  },
]