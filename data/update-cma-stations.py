import json
import sys
import urllib.request
from datetime import date
from pathlib import Path
SOURCE = 'https://weather.cma.cn/api/map/weather/1'
OUT = Path(__file__).with_name('CMA-Station-List.csv')
IDX_ID, IDX_NAME, IDX_LAT, IDX_LON = 0, 1, 4, 5
def main() -> int:
    req = urllib.request.Request(SOURCE, headers={
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0',
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read().decode('utf-8'))
    cities = payload.get('data', {}).get('city')
    if not isinstance(cities, list) or not cities:
        print('接口没有返回站点列表，未做改动', file=sys.stderr)
        return 1
    rows = []
    for entry in cities:
        try:
            sid = str(entry[IDX_ID]).strip()
            name = str(entry[IDX_NAME]).strip()
            lat = float(entry[IDX_LAT])
            lon = float(entry[IDX_LON])
        except (IndexError, TypeError, ValueError):
            continue
        if not sid or not name:
            continue
        rows.append((sid, name, lat, lon))
    if len(rows) < 1000:
        print(f'只解析出 {len(rows)} 个站点，与预期不符，未做改动', file=sys.stderr)
        return 1
    lines = [
        f'# CMA-Station-List v{date.today():%Y%m%d}',
        '# 中国气象局站点索引，用于把经纬度解析成 weather.cma.cn 的站号。',
        f'# 来源 {SOURCE} ，只保留站号/站名/经纬度。',
        '# 由 data/update-cma-stations.py 生成，不要手改。',
        'Station_ID,Station_Name,Latitude,Longitude',
    ]
    lines += [f'{sid},{name},{lat:.3f},{lon:.3f}' for sid, name, lat, lon in rows]
    OUT.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'{OUT.name}: {len(rows)} 个站点，{OUT.stat().st_size:,} 字节')
    return 0
if __name__ == '__main__':
    sys.exit(main())
