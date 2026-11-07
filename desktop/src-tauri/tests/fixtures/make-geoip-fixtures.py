"""Writes the two tiny MMDB fixtures the geoip tests read.

They mimic the DB-IP Lite schema (city and ASN) but cover only documentation ranges
(RFC 5737 / RFC 3849), so no real address or real DB-IP data is in the repo.

    pip install mmdb-writer && python3 make-geoip-fixtures.py
"""
from pathlib import Path

from mmdb_writer import MMDBWriter, MmdbU32
from netaddr import IPSet

here = Path(__file__).parent

city = MMDBWriter(ip_version=6, ipv4_compatible=True, database_type="DBIP-City-Lite", languages=["en"], description="rig-doctor test fixture")
city.insert_network(IPSet(["198.51.100.0/24"]), {
    "city": {"names": {"en": "Chicago"}},
    "continent": {"code": "NA", "names": {"en": "North America"}},
    "country": {"iso_code": "US", "names": {"en": "United States"}},
    "location": {"latitude": 41.8781, "longitude": -87.6298},
    "subdivisions": [{"names": {"en": "Illinois"}}],
})
city.insert_network(IPSet(["2001:db8::/32"]), {
    "city": {"names": {"en": "Frankfurt am Main"}},
    "country": {"iso_code": "DE", "names": {"en": "Germany"}},
    "location": {"latitude": 50.1109, "longitude": 8.6821},
})
# A country-only record: no coordinates, so it is not a usable location.
city.insert_network(IPSet(["203.0.113.0/24"]), {"country": {"iso_code": "US", "names": {"en": "United States"}}})
city.to_db_file(str(here / "geoip-city-test.mmdb"))

asn = MMDBWriter(ip_version=6, ipv4_compatible=True, database_type="DBIP-ASN-Lite (compat=GeoLite2-ASN)", description="rig-doctor test fixture")
asn.insert_network(IPSet(["198.51.100.0/24"]), {"autonomous_system_number": MmdbU32(6507), "autonomous_system_organization": "Riot Games, Inc"})
asn.to_db_file(str(here / "geoip-asn-test.mmdb"))
