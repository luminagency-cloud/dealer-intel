# External Ad compliance API
This document covers the current machine-to-machine grading flow for internal integrations.

Endpoints
POST /api/external/v1/requestBatchId
POST /api/external/v1/gradeAd
/requestBatchId creates one server-issued batch token. /gradeAd grades one ad and attaches it to that batch.

## Auth
Send both headers on every request:
x-adgrader-client-id
x-adgrader-client-secret

Provision clients with:
npm run api-client:create -- --id partner_alpha --name "Partner Alpha"
The script writes the hashed secret to api_clients and prints the plain secret once. Store that output securely.

## Setup Checklist
Before provisioning a client, make sure:
the database includes migrations/20260510_external_api_clients.sql
the database includes migrations/20260511_external_api_batches.sql
DATABASE_URL is available, either in the shell or in backend/.env

External API records are stored in:
api_clients: one row per machine-to-machine client credential
api_client_batches: one row per caller-created batch token
ad_grades.client_id: which API client created the saved grade
ad_grades.batch_id: which batch the saved grade belongs to

Step 1: Request A Batch ID
POST /api/external/v1/requestBatchId
Request body:
{
  "batchName": "Elmwood lease specials"
}
Successful response:
{
  "success": true,
  "requestId": "uuid",
  "batchId": "server-issued-batch-id",
  "batchName": "Elmwood lease specials",
  "createdAt": "2026-05-11T13:47:00.000Z"
}

Notes:
batchName is required
the caller should treat batchId as the stable grouping token for the rest of that batch
callers may reuse the same human batch name later; the server-issued batchId is what keeps runs separate
Step 2: Grade Ads Against That Batch
POST /api/external/v1/gradeAd
Request body:
{
  "imageBase64": "BASE64_IMAGE_BYTES",
  "imageMimeType": "image/png",
  "rawText": "Optional OCR or already-known ad copy",
  "disclaimerText": "Optional known disclaimer text",
  "metadata": {
    "batchId": "server-issued-batch-id",
    "dealerName": "Example Auto",
    "originalFileName": "creative.png",
    "selectedMarketStates": ["RI"]
  }
}
Successful response:
{
  "success": true,
  "requestId": "uuid",
  "result": {
    "id": "grade-id",
    "created_at": "2026-05-10T00:00:00.000Z",
    "vehicle": "2026 RAM 1500",
    "score": 90,
    "grade": "A-",
    "color": "GREEN",
    "ruleset_version": "050126",
    "graded_by": "api",
    "findings": {
      "adType": "finance",
      "selectedMarketStates": ["RI"],
      "submissionMetadata": {
        "batchId": "server-issued-batch-id",
        "batchName": "Elmwood lease specials"
      },
      "violations": [],
      "bonuses": []
    }
  },
  "warning": null
}

#Notes:
client_id is intentionally not echoed back in the response
warning may be present when grading succeeded but durable image storage failed
Validation Rules
/requestBatchId:
request body must be a JSON object
batchName is required
batchName must be 180 characters or fewer
/gradeAd:
request body must be a JSON object
metadata must be an object
metadata.batchId is required
metadata.selectedMarketStates must contain at least one valid state code
metadata.batchId must belong to the authenticated API client
imageMimeType must be one of image/jpeg, image/png, image/gif, or image/webp
image payloads must be valid base64 and under the route limits
Recommended Caller Behavior
request one batchId before entering the ad-processing loop
reuse that batchId on every gradeAd call in the batch
log the returned requestId from every response
treat non-2xx responses as submission failures