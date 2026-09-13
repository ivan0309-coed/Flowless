# API examples

All endpoints use `/api/v1`. Browser requests use a server-side session cookie. External systems use a scoped token created by an administrator and send `Authorization: Bearer flw_...`.

The full route inventory is available at `GET /api/v1/openapi.json`. API tokens are shown only once when created; `GET /tokens` lists metadata and `DELETE /tokens/{id}` revokes a token without storing or revealing its plaintext value.

Create an event:

```bash
curl -X POST http://localhost:3000/api/v1/requests \
  -H 'Authorization: Bearer flw_REPLACE_ME' \
  -H 'Idempotency-Key: erp-purchase-1042' \
  -H 'Content-Type: application/json' \
  -d '{
    "externalId":"ERP-PO-1042",
    "description":"需要购买一台8万元GPU服务器，用于AI项目测试。",
    "context":{"eventType":"procurement","amountMinor":8000000,"currency":"CNY"}
  }'
```

Start analysis with `POST /requests/{id}/analyze`. Query `GET /requests/{id}` until the request needs information or is ready for confirmation. Human confirmation and submission remain separate operations.

Read the decision:

```json
{
  "requestId": "…",
  "revision": 1,
  "contextHash": "sha256…",
  "status": "pending",
  "canProceed": false
}
```

Only `status: "allow"` has `canProceed: true`. Callers must verify that the returned revision and context hash match the action they intend to execute.

`GET /requests/{id}/audit` returns the append-only history to the requester, assigned approvers, or an administrator. An unrelated account receives `403` for both Decision and Audit endpoints.
