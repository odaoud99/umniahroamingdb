# TAP/TADIG country enrichment research

Research date: 13 October 2026 (Asia/Riyadh).

## Result

The workbook contains **481 unique TAP codes** across seven service sheets. `tap_countries.json` includes all 481, with the original code, country, source URL, verification status, explanatory note, and associated workbook IMSI prefixes.

- **472 `inferred_prefix`**: public geographic-prefix inference or explicitly described public corroboration.
- **9 `unresolved`**: international/non-geographic networks; `country` is `null`.
- **0 `verified_raex`**: no authenticated RAEX record was available to this research agent.

Country labels describe inferred country/area associations and must not be interpreted as the operator's current coverage area. In particular, GSMA documents exceptions for certain legacy codes and US territory coverage. Prefix inference alone cannot verify a current roaming agreement or identify an operator's live registration.

## Authoritative sources

1. [GSMA Member Gateway features](https://www.gsma.com/get-involved/gsma-membership/make-a-difference/member-gateway/member-gateway-features/) describes RAEX, authorised IR.21 catalogue APIs, and TADIG management. A Member Gateway account is needed for Roaming Gateway access.
2. [GSMA Roaming Gateway support](https://www.gsma.com/get-involved/gsma-membership/get-in-touch/?topic=Roaming+Gateway+Support) states that access is limited to Operator and Rapporteur members. Users request RAEX roles in Member Gateway under **My Member Gateway → My Roles**; their organisation's MIM approves the request. No account login or authorised API connection was provided here.
3. [GSMA IR.21 v17.0](https://www.gsma.com/newsroom/wp-content/uploads/IR.21-v17.0.pdf), section D.1, defines Organisation Country Initials and the network TADIG summary. Those explicit fields in an authorised record are the appropriate basis for RAEX verification; public format specifications do not supply a current operator-country catalogue.
4. [GSMA TD.13 v10.3](https://www.gsma.com/newsroom/wp-content/uploads/2013/07/TD-13-v10-3.pdf), sections 2.3 and 4, documents the country-prefix convention, legacy exceptions, non-geographic prefixes, and the Kosovo prefix. This is a historical public reference used to explain prefix inference, not a current RAEX directory.
5. [UN Statistics Division M49 overview](https://unstats.un.org/unsd/methodology/m49/overview) provides the English country/area names and ISO alpha-3 codes. `iso_countries.json` is the parsed English country table, retrieved during this research.
6. [ITU Operational Bulletin 895](https://www.itu.int/dms_pub/itu-t/opb/sp/T-SP-OB.895-2007-OAS-PDF-E.pdf), section 3.7 on page 17, associates MCC/MNC 22001 with Serbia. This corroborates workbook code YUGMT's legacy-prefix inference.
7. [MTX Connect's official contact page](https://contacts.mtxc.eu/) identifies MTX01 with MCC/MNC 27002 and the operator's Luxembourg licence. This provides public corroboration for MTX01's Luxembourg label; it does not make it RAEX-verified.

Some direct GSMA page fetches returned HTTP 403. Relevant official pages and specification excerpts were available through indexed search results. No access control was bypassed.

## Exceptions handled

| Codes | Treatment | Reason |
| --- | --- | --- |
| ROM05, ROMCS, ROMMF | Romania, inferred | GSMA documents Romania's old country prefix. |
| SUDMO | Sudan, inferred | GSMA documents Sudan's old country prefix. |
| K00K8 | Kosovo, inferred | GSMA TD.13 explicitly assigns the special prefix K00; it is not an ISO alpha-3 code. |
| YUGMT | Serbia, inferred | YUG historically covered Serbia and Montenegro; workbook IMSI 22001 plus ITU corroboration resolves this entry provisionally. |
| MTX01 | Luxembourg, inferred/publicly corroborated | Operator's own published registration identifies the exact code. |
| AAZTD, AAZTR, AAZVF | Unresolved/non-geographic | AAZ denotes non-geographic M2M; workbook IMSIs use MCC 901. |
| ARETH, EMNDE, MLTMA, MTX02, NORMC, TELA1 | Unresolved/international | Workbook IMSIs use MCC 901, so a geographic country should not be invented from a prefix or company headquarters. |

The JSON statuses deliberately reserve `verified_raex` for a future authorised record import. MTX01 and YUGMT have stronger public corroboration than ordinary prefixes but are still marked `inferred_prefix` because the allowed status vocabulary has no separate public-verification value; their notes state the exact basis.

## Completing RAEX verification

Use an authorised RAEX IR.21 export or a member-approved API connection. Join each explicit network TADIG entry to its Organisation Country Initials, retaining the original document/export, retrieval time, and organisation/network context. Resolve non-geographic networks explicitly rather than substituting a headquarters country. Record the source and audit the update in the system. Never mark a manually typed label or prefix-only inference as `verified_raex`.

`scripts/enrich_tap_countries.py` reproduces the public inference and reads only columns A/B from the workbook service sheets. It does not log in to RAEX, request credentials, alter the workbook, or claim that its output is an authenticated RAEX export.
