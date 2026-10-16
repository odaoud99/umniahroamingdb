# IR21 / IR85 document agent

The project owner currently has no RAEX access. No partner documents have been downloaded or described as verified. The **IR21 & IR85** tab lists both document slots for every stored TAP code, exposes missing documents, keeps previous versions, and lets administrators upload authorized PDF/XML files up to 3 MB. IR85 concerns roaming hubs; a missing IR85 slot does not mean every operator should publish one.

## Authorized access required

The [Roamsys integration guide](https://cdn.roamsys.com/documents/raextools/raextools-3rd-party-api-integration-guide.pdf) describes registered application access and authorized user tokens. The actual authenticated Swagger contract and permissions must be obtained through the organization's GSMA/RAEX administrator before implementing a native RAEX adapter. This system does not guess private API endpoints, bypass authentication, or scrape protected documents.

The included agent accepts a **normalized, organization-approved export feed**. This is an explicit bridge contract, not a claim that RAEX natively exposes this JSON endpoint. A future adapter must download only documents that the organization is entitled to receive and transform the provider's actual responses into this contract.

## Feed contract

Configure these private Production environment settings in the existing Vercel project, then redeploy:

| Variable | Meaning |
| --- | --- |
| `RAEX_FEED_URL` | Fixed HTTPS URL of the approved export bridge, without query, credentials, or fragment. |
| `RAEX_FEED_TOKEN` | Private bearer token accepted by that bridge. |
| `CRON_SECRET` | Long random secret used to authenticate scheduled requests. |

The agent calls `GET RAEX_FEED_URL`, with `Authorization: Bearer RAEX_FEED_TOKEN`. Subsequent pages add `?cursor=...`. The response is JSON, at most 4 MB and 20 documents per run:

```json
{
  "documents": [
    {
      "tap_code": "ARETC",
      "kind": "IR21",
      "revision": "provider-version",
      "source_at": "2026-10-01T00:00:00Z",
      "filename": "partner-ir21.pdf",
      "content_base64": "BASE64_OF_ORIGINAL_FILE"
    }
  ],
  "next_cursor": "opaque-continuation-cursor"
}
```

Use `IR21` or `IR85`. `source_at` is the document issue timestamp, not the retrieval time. Only TAP codes already stored in this database are imported; other partner codes and older feed versions are skipped. `next_cursor` may be null/empty after the final page; the next run starts a fresh sweep. A bridge should return deltas or suitably sized pages. Large initial imports take multiple scheduled runs or administrator checks. Never place live files, feed tokens, or RAEX credentials in this public Git repository.

## Schedule and behavior

Vercel schedules `/api/cron/raex` once daily at 06:00 UTC (09:00 UTC+3), with execution within the scheduled hour on the current Hobby plan; see [Vercel scheduling limits](https://vercel.com/docs/cron-jobs/usage-and-pricing). Without a feed it returns `awaiting_access` and makes no network calls. With a feed configured, scheduled requests require `CRON_SECRET`. Administrators can also use **Check feed now**.

The agent uses a database lease to avoid overlapping runs. SHA-256 detects unchanged content. Older issue dates cannot replace a newer current file. Versions, original bytes and notifications are durable database records; a new version does not delete the old one. Each accepted update creates one in-app notification, visible to all users, with personal read status. Signed-in pages refresh notification badges every 30 seconds while visible. Email or browser push notifications are not configured.

The cursor advances only after a successful page. A failed page preserves the prior cursor and all stored documents; retries skip content already saved. Last-run failures are shown in the document tab without exposing provider credentials. Automated tests use synthetic PDF/XML files and a mocked feed; they do not prove access to RAEX or partner document coverage.

## Administrator password requests

**Forgot your password?** now creates a shared **Pending** request, visible to every administrator in **Password requests** and the navigation badge. A duplicate submission leaves one open request per account. Known and unknown usernames receive the same public response. Microsoft 365 is not required for this flow.

After verifying the requester's identity through an approved company channel, an administrator selects **Reset & complete**, confirms their own password, provides a reason, and sets a replacement password. The password change, session invalidation and **Done** status happen in one transaction. Completed rows show who acted and the actual completion time. Concurrent administrators cannot execute the same request twice. No password is sent through the request queue or stored in plaintext. The administrator arranges password handover through the organization's approved channel.
