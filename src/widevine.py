#!/usr/bin/env python3
"""
Extract Widevine content decryption keys using pywidevine.

Usage:
    python3 widevine.py <mpd_url> <license_url> <cdm_dir>

Arguments:
    mpd_url     - URL to the DASH manifest (.mpd)
    license_url - Widevine license server URL
    cdm_dir     - Directory containing client_id.bin and private_key.pem

Output:
    JSON array of {kid, key} pairs (hex-encoded) on stdout.
    Logs go to stderr so they don't interfere with JSON output.
"""
import sys
import json
import re
import base64
import logging
from pathlib import Path
from xml.etree import ElementTree

import requests
from pywidevine.cdm import Cdm
from pywidevine.device import Device
from pywidevine.pssh import PSSH

logging.basicConfig(
    level=logging.INFO,
    format="[widevine] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger(__name__)

WIDEVINE_SYSTEM_ID = "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"

# Namespaces used in DASH manifests
NS = {
    "mpd": "urn:mpeg:dash:schema:mpd:2011",
    "cenc": "urn:mpeg:cenc:2013",
    "mspr": "urn:microsoft:playready",
}


def fetch_mpd(url: str) -> str:
    log.info("Fetching MPD: %s", url[:120])
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    resp.raise_for_status()
    return resp.text


def extract_pssh_from_mpd(mpd_xml: str) -> str | None:
    """Extract the Widevine PSSH box (base64) from a DASH manifest."""
    root = ElementTree.fromstring(mpd_xml)

    # Search all ContentProtection elements
    for cp in root.iter("{urn:mpeg:dash:schema:mpd:2011}ContentProtection"):
        scheme = cp.get("schemeIdUri", "").lower()
        if WIDEVINE_SYSTEM_ID in scheme:
            # Look for cenc:pssh child
            pssh_el = cp.find("{urn:mpeg:cenc:2013}pssh")
            if pssh_el is not None and pssh_el.text:
                pssh_b64 = pssh_el.text.strip()
                log.info("Found PSSH in ContentProtection element")
                return pssh_b64

    # Fallback: search for PSSH in any element text that looks like base64
    for el in root.iter():
        if el.tag.endswith("}pssh") and el.text:
            text = el.text.strip()
            try:
                data = base64.b64decode(text)
                # Check for Widevine system ID in the binary PSSH box
                wv_bytes = bytes.fromhex(WIDEVINE_SYSTEM_ID.replace("-", ""))
                if wv_bytes in data:
                    log.info("Found PSSH via binary scan")
                    return text
            except Exception:
                continue

    return None


def extract_pssh_from_init_segment(mpd_xml: str, mpd_url: str) -> str | None:
    """If PSSH isn't in the manifest XML, try fetching an init segment."""
    root = ElementTree.fromstring(mpd_xml)
    base_url = mpd_url.rsplit("/", 1)[0] + "/"

    for seg_tmpl in root.iter("{urn:mpeg:dash:schema:mpd:2011}SegmentTemplate"):
        init_attr = seg_tmpl.get("initialization")
        if not init_attr:
            continue

        # Replace template variables with reasonable defaults
        init_path = re.sub(r"\$RepresentationID\$", "1", init_attr)
        init_path = re.sub(r"\$Bandwidth\$", "0", init_path)
        init_url = init_path if init_path.startswith("http") else base_url + init_path

        log.info("Fetching init segment: %s", init_url[:120])
        try:
            resp = requests.get(
                init_url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15
            )
            resp.raise_for_status()
            data = resp.content

            # Scan for PSSH box in the init segment binary
            pssh = extract_pssh_from_binary(data)
            if pssh:
                return pssh
        except Exception as e:
            log.warning("Failed to fetch init segment: %s", e)
            continue

    return None


def extract_pssh_from_binary(data: bytes) -> str | None:
    """Extract Widevine PSSH box from binary MP4 data (init segment)."""
    wv_bytes = bytes.fromhex(WIDEVINE_SYSTEM_ID.replace("-", ""))
    offset = data.find(wv_bytes)
    if offset < 0:
        return None

    # PSSH box starts 12 bytes before the system ID
    # Box structure: [4 bytes size][4 bytes 'pssh'][4 bytes version+flags][16 bytes systemID][...]
    box_start = offset - 12
    if box_start < 0:
        return None

    box_size = int.from_bytes(data[box_start : box_start + 4], "big")
    if box_start + box_size > len(data):
        return None

    pssh_box = data[box_start : box_start + box_size]
    pssh_b64 = base64.b64encode(pssh_box).decode()
    log.info("Extracted PSSH from init segment binary (%d bytes)", len(pssh_box))
    return pssh_b64


def get_keys(pssh_b64: str, license_url: str, cdm_dir: str) -> list[dict]:
    """Use pywidevine to obtain content decryption keys."""
    cdm_path = Path(cdm_dir)
    client_id = cdm_path / "client_id.bin"
    private_key = cdm_path / "private_key.pem"

    if not client_id.exists() or not private_key.exists():
        raise FileNotFoundError(
            f"CDM files not found in {cdm_dir}. "
            f"Need client_id.bin and private_key.pem"
        )

    log.info("Loading CDM from %s", cdm_dir)
    device = Device(
        client_id=client_id.read_bytes(),
        private_key=private_key.read_bytes(),
        type_=Device.Types.ANDROID,
        security_level=3,
    )
    cdm = Cdm.from_device(device)
    session_id = cdm.open()

    try:
        pssh = PSSH(pssh_b64)
        challenge = cdm.get_license_challenge(session_id, pssh)

        log.info("Sending license request to %s", license_url[:120])
        resp = requests.post(
            license_url,
            data=challenge,
            headers={
                "Content-Type": "application/octet-stream",
                "User-Agent": "Mozilla/5.0",
            },
            timeout=30,
        )
        resp.raise_for_status()

        cdm.parse_license(session_id, resp.content)

        keys = []
        for key in cdm.get_keys(session_id):
            if key.type == "CONTENT":
                keys.append(
                    {
                        "kid": key.kid.hex,
                        "key": key.key.hex(),
                    }
                )
                log.info("Got content key: KID=%s", key.kid.hex)

        if not keys:
            log.warning("No CONTENT keys found in license response")
            # Include all key types for debugging
            for key in cdm.get_keys(session_id):
                log.info("  Key type=%s kid=%s", key.type, key.kid.hex)

        return keys
    finally:
        cdm.close(session_id)


def main():
    if len(sys.argv) != 4:
        print(
            f"Usage: {sys.argv[0]} <mpd_url> <license_url> <cdm_dir>",
            file=sys.stderr,
        )
        sys.exit(1)

    mpd_url, license_url, cdm_dir = sys.argv[1], sys.argv[2], sys.argv[3]

    # 1. Fetch and parse the DASH manifest
    mpd_xml = fetch_mpd(mpd_url)

    # 2. Extract PSSH from manifest XML
    pssh_b64 = extract_pssh_from_mpd(mpd_xml)

    # 3. If not in XML, try init segment
    if not pssh_b64:
        log.info("PSSH not found in manifest XML, trying init segment...")
        pssh_b64 = extract_pssh_from_init_segment(mpd_xml, mpd_url)

    if not pssh_b64:
        log.error("Could not find Widevine PSSH in manifest or init segments")
        sys.exit(1)

    log.info("PSSH (b64): %s", pssh_b64[:60] + "...")

    # 4. Get decryption keys
    keys = get_keys(pssh_b64, license_url, cdm_dir)

    if not keys:
        log.error("No content keys obtained")
        sys.exit(1)

    # 5. Output keys as JSON to stdout
    json.dump(keys, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
