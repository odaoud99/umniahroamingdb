"""Build cautious country enrichment from official public country-code sources.

This does not claim to access authenticated GSMA RAEX records. Country names
inferred from TADIG prefixes must be reviewed against an authorised IR.21 export.
"""
from __future__ import annotations

import collections
import html
import json
from pathlib import Path
import re
import urllib.request

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
UN_URL = "https://unstats.un.org/unsd/methodology/m49/overview"
TD13_URL = "https://www.gsma.com/newsroom/wp-content/uploads/2013/07/TD-13-v10-3.pdf"
ITU_SERBIA_URL = "https://www.itu.int/dms_pub/itu-t/opb/sp/T-SP-OB.895-2007-OAS-PDF-E.pdf"
MTX_URL = "https://contacts.mtxc.eu/"


def country_codes() -> dict[str, str]:
    with urllib.request.urlopen(UN_URL, timeout=30) as response:
        document = response.read().decode("utf-8")
    table = re.search(r'<table\s+id\s*=\s*"downloadTableEN"[^>]*>(.*?)</table>', document, re.S)
    if not table:
        raise ValueError("Official UN English country table was not found")
    countries = {}
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", table.group(1), re.S):
        cells = [html.unescape(re.sub(r"<[^>]+>", "", value)).strip()
                 for value in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        if len(cells) >= 12 and re.fullmatch(r"[A-Z]{3}", cells[11]):
            countries[cells[11]] = cells[8]
    if len(countries) < 240:
        raise ValueError("Official UN country table was incomplete")
    return countries


def main() -> None:
    countries = country_codes()
    workbook = openpyxl.load_workbook(ROOT / "Umniah Roaming DB.xlsx", read_only=True, data_only=True)
    tap_imsis = collections.defaultdict(set)
    for sheet in workbook:
        for row in sheet.iter_rows(min_row=3, values_only=True):
            if len(row) > 1 and row[1]:
                tap_imsis[str(row[1]).strip().upper()].add(str(row[0]).strip())
    workbook.close()
    entries = []
    for tap, imsis in sorted(tap_imsis.items()):
        prefix = tap[:3]
        country = countries.get(prefix)
        source = UN_URL
        status = "inferred_prefix" if country else "unresolved"
        note = "Country inferred from the three-character TADIG prefix; not verified against a RAEX record."
        if prefix in {"ROM", "SUD", "K00"}:
            country = {"ROM": "Romania", "SUD": "Sudan", "K00": "Kosovo"}[prefix]
            status, source = "inferred_prefix", TD13_URL
            note = "GSMA TD.13 documents this legacy/special country prefix; individual code not verified in RAEX."
        elif tap == "YUGMT" and all(i.startswith("220") for i in imsis):
            country, status = "Serbia", "inferred_prefix"
            source = ITU_SERBIA_URL
            note = "Legacy YUG prefix is ambiguous; workbook IMSI MCC/MNC 22001 matches the ITU Serbia allocation. Not RAEX-verified."
        elif tap == "MTX01":
            country, status, source = "Luxembourg", "inferred_prefix", MTX_URL
            note = "Official operator website identifies MTX01 and MCC/MNC 27002 as Luxembourg. Public corroboration, not RAEX verification."
        if any(i.startswith("901") for i in imsis):
            country, status, source = None, "unresolved", TD13_URL
            note = "Workbook IMSI uses international MCC 901; no single geographic country assigned without an authorised RAEX record."
            if prefix == "AAZ":
                note = "AAZ is a GSMA non-geographic M2M prefix; this international network has no country inferred."
        elif not country:
            note = "Prefix is not a recognised geographic ISO code and needs an authorised RAEX lookup."
        entries.append({"tap_code": tap, "country": country, "source": source,
                        "verification_status": status, "country_note": note,
                        "imsi_prefixes": sorted(imsis)})
    output = ROOT / "data"
    output.mkdir(exist_ok=True)
    (output / "tap_countries.json").write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (output / "iso_countries.json").write_text(json.dumps(countries, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"total": len(entries), "statuses": dict(collections.Counter(e["verification_status"] for e in entries)),
                      "unresolved": [e["tap_code"] for e in entries if e["verification_status"] == "unresolved"]}))


if __name__ == "__main__":
    main()
