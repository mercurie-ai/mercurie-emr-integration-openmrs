# Mercurie EMR Integration - OpenMRS Adapter

This project is a middleware adapter that seamlessly integrates [Mercurie](https://www.mercurie.ai/), a medical conversation transcription and summarization service, with [OpenMRS](https://openmrs.org/), an open-source electronic medical record (EMR) system. It serves as a proof-of-concept to demonstrate how Mercurie can be connected to various EMRs to automate clinical documentation.

See the adapter in action in this video:

[![Mercurie OpenMRS Integration Video](https://img.youtube.com/vi/jYGUoWqMl9c/mqdefault.jpg)](https://www.youtube.com/watch?v=jYGUoWqMl9c&ab_channel=Mercurie)

## The Goal

The primary goal of Mercurie is to alleviate the burden of medical documentation for physicians. By simply having a natural conversation with a patient, Mercurie can transcribe, understand, and structure the clinical information. This middleware shows that the structured output from Mercurie can be used to automatically and accurately populate a patient's chart in an EMR like OpenMRS, saving physicians valuable time and reducing administrative overhead.

## How It Works

This adapter exposes a set of API endpoints that Mercurie is designed to communicate with. When a medical conversation is processed by Mercurie, it extracts key clinical information such as:

*   **Clinical Notes:** A summary of the conversation.
*   **Diagnoses:** Identified medical conditions.
*   **Medication Orders:** Prescriptions discussed during the visit.

This structured data is then sent to the middleware's API. The middleware then transforms this data into the appropriate FHIR (Fast Healthcare Interoperability Resources) and REST API formats that OpenMRS understands and securely sends it to the OpenMRS server to update the patient's record.

This project illustrates that with a similar middleware, any EMR can be integrated with Mercurie to achieve the same level of documentation automation.

## Features

*   **Patient Retrieval:** Fetches a list of patients from OpenMRS to be displayed in the Mercurie interface.
*   **Clinical Note Creation:** Creates new encounter notes in OpenMRS from the transcribed conversation.
*   **Structured Data Ingestion:** Parses structured JSON from Mercurie containing clinical notes, diagnoses, and medication orders.
*   **Diagnosis Management:** Adds new diagnoses to the patient's record.
*   **Medication Ordering:** Creates new medication orders within the patient's chart.
*   **Encounter History:** Allows viewing of past encounter notes from within the Mercurie interface.

## Getting Started

These instructions will get you a copy of the project up and running on your local machine for development and testing purposes.

### Prerequisites

*   Node.js and npm
*   An running instance of OpenMRS
*   Access to the Mercurie platform to configure the integration

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/mercurie-openmrs-adapter.git
    cd mercurie-openmrs-adapter
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Set up your environment variables:**
    Create a `.env` file in the root of the project and add the following configuration. Be sure to replace the placeholder values with your actual OpenMRS and server details.

    ```
    # --- Server Configuration ---
    PORT=3001
    API_KEY=your-super-secret-api-key
    BASE_URL=http://localhost:3001

    # --- OpenMRS Configuration ---
    OPENMRS_FRONTEND_URL=http://localhost/openmrs/spa
    OPENMRS_REST_BASE_URL=http://localhost/openmrs/ws/rest/v1
    OPENMRS_FHIR_BASE_URL=http://localhost/openmrs/ws/fhir2/R4
    OPENMRS_USERNAME=admin
    OPENMRS_PASSWORD=Admin123
    OPENMRS_DEFAULT_LOCATION_UUID=92dbdbdf-17da-4cf0-873c-ad15dfae71cb
    OPENMRS_DEFAULT_PRACTITIONER_UUID="705f5791-07a7-44b8-932f-a81f3526fc98"
    ```

4.  **Generate API types (optional):**
    The types for the Mercurie-facing API are generated from the `openapi.yaml` file. This is typically done automatically before starting the server, but you can run it manually:
    ```bash
    npm run generate-types
    ```

5.  **Start the server:**
    To run the server in development mode with auto-reloading:
    ```bash
    npm run dev
    ```
    For production:
    ```bash
    npm start
    ```

### Mercurie Configuration

You will need to update the 'External EMR' configuration on Mercurie. If using the placeholder values in the `.env` file, set
- Endpoint: `http://localhost:3001/endpoints`
- API Key: `your-super-secret-api-key`.

To get the data in the format expected by this adapter you will have to use this template in Mercurie (see [this guide](https://www.mercurie.ai/guides/prescriptionschema?tab=rules) for rules and examples for setting the 'Clinical Note' subtemplate ):

```
Diagnoses: [
    Diagnosis: Name of the condition diagnosed.
    Certainty: One of 'Confirmed' or 'Provisional'.
    Rank: One of 'Primary' or 'Secondary'.
]

Clinical Note: {
    <arbitrary_subtemplate_for_clinical_notes>
}

Medications: [
    Name: Name of the drug. For example, Aspirin, Paracetamol.
    Strength: Strength of the drug. For example, 81mg for the Aspirin 81mg, 500mg for the Paracetamol 500mg.
    Dose: Drug dosage without the unit. For example, if the dosage is 1 tablet, this should be 1.
    Dose Unit: The unit for the drug dosage. For example, 'Tablet', 'Teaspoon'.
    Route: Drug intake route. For example, 'Oral', 'Intravenous', 'Intranasal'.
    Frequency: Frequency of drug intake. For example, 'Once daily', 'Every hour'.
    Patient Instructions_: Any additonal instructions to the patient regarding drug dosing. For example, 'Take after eating'.
    PRN Reason_: Reason to take the drug, if to be taken as needed. Leave blank if not PRN.
    Duration: Duration for how long the drug has to be taken, without the unit. For example, if the duration is 5 days, this should be 5.
    Duration Unit: The unit of the drug duration. For example, 'Days', 'Weeks', or 'Months'.
    Dispense Quantity: The quantity of drugs to dispense, without the unit. For example, for 7 tablets to be dispensed, this should be 7. This may be calculated from the dose and the duration.
    Dispense Unit: The unit of dispense quantity. For example, 'Tablet', 'Milliliter', 'Teaspoon', 'Packet'.
    Refills: Number of refills the patient can take for this drug. Default is 0.
    Indication: Condition for which the drug is to be used.
]
```

## API Endpoints

The middleware exposes the following endpoints as defined in the `openapi.yaml` specification.

*   `GET /endpoints`: Provides a list of all available API endpoints.
*   `GET /patients`: Returns a list of all patients from OpenMRS.
*   `POST /notes`: Creates or updates a clinical note, diagnoses, and medication orders for a patient.
*   `GET /patients/:patientId/encounters`: Retrieves a list of past encounters for a specific patient.
*   `GET /encounters/:encounterId`: Fetches the detailed note for a specific encounter.
*   `GET /patient-summary/:patientId`: Gets a summary of the patient's active conditions and medications.
*   `GET /med-templates`: Provides a list of medication templates to aid in ordering.

All endpoints require an `Authorization: Bearer <your-api-key>` header.

## Extensibility

The architecture of this middleware is designed to be a blueprint. By replacing the `openmrs-api.ts` module with a different implementation that communicates with another EMR's API, you can quickly adapt this integration for other systems. The core logic in `server.ts` and the API contract defined in `openapi.yaml` can remain largely the same, providing a consistent integration point for Mercurie.

The schema for the Mercurie integration API and a list of available integration adapters are maintained on the [mercurie-ai/mercurie-emr-integration](https://github.com/mercurie-ai/mercurie-emr-integration) GitHub repository.