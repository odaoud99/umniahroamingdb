"""Read the supplied workbook without modifying it; preserve every populated row."""
import json, hashlib, collections
from pathlib import Path
import openpyxl

root = Path(__file__).resolve().parent.parent
book = openpyxl.load_workbook(root / 'Umniah Roaming DB.xlsx', data_only=True)
rows, counts = [], {}
for sheet in book:
    count = 0
    for index, row in enumerate(sheet.values, 1):
        if index < 3 or not any(row[:2]):
            continue
        if row[0] is None or row[1] is None:
            raise ValueError(f'Incomplete source record: {sheet.title}:{index}')
        imsi = str(int(row[0])) if isinstance(row[0], (float, int)) else str(row[0]).strip()
        tap = str(row[1]).strip().upper()
        service, direction = sheet.title.rsplit(' ', 1)
        rows.append({'id': f'seed-{len(rows)+1}', 'tap_code': tap, 'imsi_prefix': imsi,
                     'service': service, 'direction': direction,
                     'source_sheet': sheet.title, 'source_row': index})
        count += 1
    counts[sheet.title] = count
keys = collections.Counter((r['tap_code'],r['imsi_prefix'],r['service'],r['direction']) for r in rows)
report = {'source': 'Umniah Roaming DB.xlsx', 'sha256': hashlib.sha256((root/'Umniah Roaming DB.xlsx').read_bytes()).hexdigest(),
          'rows': len(rows), 'unique_tap_codes': len({r['tap_code'] for r in rows}), 'sheets': counts,
          'duplicate_rows_preserved': sum(v-1 for v in keys.values()), 'import_policy': 'All populated source rows preserved, including duplicates.'}
(root/'data').mkdir(exist_ok=True)
(root/'data/seed.json').write_text(json.dumps(rows,ensure_ascii=False),encoding='utf-8')
(root/'data/import-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2))
