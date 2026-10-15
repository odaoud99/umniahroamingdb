# Microsoft 365 password recovery — Umniah Roaming Database

The application supports Microsoft 365 recovery emails through Microsoft Graph. Live delivery is not configured or verified by these code changes. An approved sender mailbox and Microsoft 365 administrator setup are required. Keep all secrets in hosting environment settings; never commit or paste them into chat.

## Configure the sending application

1. Ask your Microsoft 365 administrator to register or approve a single-tenant application for this system and provision a client secret.
2. Configure app-only email sending permission for the approved sender mailbox. Use an appropriate mailbox-scoped application role/permission arrangement following [Microsoft's Exchange application RBAC documentation](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac). The app uses [Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0) and the [client credentials flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow). The tenant administrator must approve the permission arrangement.
3. In the production Vercel project's environment variables, add:

| Variable | Value |
|---|---|
| `APP_ORIGIN` | The stable HTTPS production URL, e.g. `https://YOUR-PRODUCTION-DOMAIN`, with no extra path, query, or fragment. Use the production domain, not a temporary deployment preview URL. |
| `M365_TENANT_ID` | Microsoft Entra tenant/directory ID. |
| `M365_CLIENT_ID` | Approved application's client ID. |
| `M365_CLIENT_SECRET` | Client secret value, stored privately. |
| `M365_SENDER` | Approved sender mailbox address or user principal name. |

4. Redeploy so the function receives these settings. Configure preview deployments separately. Track the client secret's expiration and rotate it through hosting settings when required.

The same variables can be supplied to the local process for an approved local mail test or as Cloudflare Worker secrets/settings. Missing configuration is clearly reported by the app; local demos do not send real mail.

## Populate account emails and verify

Existing usernames, passwords, partner data and logs remain in place. Existing accounts initially have no recovery email.

1. Users can save their recovery email under **My account**, after confirming their current password. Administrators can update an account's recovery email under **User Access → Reset password → Update recovery email**, after confirming their administrator password.
2. Test **Forgot your password?** using a controlled existing account. The public response stays generic regardless of whether the account exists. The email must arrive only at that account's stored address.
3. Open the email link, choose and confirm a new password, then sign in. Old passwords and existing sessions must stop working. Reusing the same link must fail; links expire in 30 minutes.
4. Review **Logs**, including `Password reset email requested`, `Password reset email failed`, `Password changed` and `Recovery email changed`. Microsoft Graph acceptance means a message was accepted for processing; check the recipient mailbox and Microsoft 365 mail tracing if delivery does not complete.

Administrators can set a replacement password directly even when email sending is unavailable. Their current password and an audit reason are required. Password changes invalidate all sessions and outstanding reset links for the affected user. Recovery email changes invalidate outstanding reset links.

## Implementation and tests

Random 256-bit links are stored as hashes, consumed atomically once and sent using the configured HTTPS origin. Reset URLs, passwords and password hashes are excluded from action logs. Client-supplied recipient addresses are ignored by the forgot-password endpoint. Vercel `waitUntil` keeps email delivery running after the generic response; provider failures revoke the affected reset link and are logged. Token issuance is gated on the current account and recovery email to avoid issuing a stale request after either changes.

`npm test` exercises the flows with isolated databases and a mocked Microsoft Graph service. It does not send real email or prove the production tenant's permissions. Follow the live verification steps above after configuration.

Security design reference: [OWASP forgot-password guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
