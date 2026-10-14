#!/usr/bin/env python3
"""Bounded TESS light-curve inventory, exploratory BLS, and offline smoke control.

Produces a motive.exoplanet.evidence.v1 document. It does not validate a planet.
"""

import argparse
import csv
import hashlib
import json
import platform
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.timeseries import BoxLeastSquares


FORMAT = "motive.exoplanet.evidence.v1"
PROTOCOL = "motive.exoplanet-hunting.pilot.v1"
PERIODS = np.linspace(1.0, 10.0, 600)
DURATION_DAYS = 0.12
SYNTHETIC_SEED = 4206066
SYNTHETIC_PERIOD = 3.2


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def versions():
    import astropy
    import astroquery

    return {"python": platform.python_version(), "numpy": np.__version__,
            "astropy": astropy.__version__, "astroquery": astroquery.__version__}


def installed_packages():
    return sorted(f"{item.metadata['Name']}=={item.version}" for item in metadata.distributions())


def prepare_out(value):
    out = Path(value)
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise RuntimeError(f"Output directory is not empty: {out}; choose a new --out path")
    out.mkdir(parents=True, exist_ok=True)
    return out


def search(time, flux):
    """Fixed grid, no tuning and no significance or false-alarm calibration."""
    model = BoxLeastSquares(time, flux)
    result = model.power(PERIODS, DURATION_DAYS, objective="snr")
    power = np.asarray(result.power, dtype=float)
    if not np.any(np.isfinite(power)):
        raise ValueError("BLS returned no finite power")
    best = int(np.nanargmax(power))
    return {"periodDays": float(result.period[best]),
            "epochBjdTdb": float(result.transit_time[best]),
            "durationHours": float(result.duration[best] * 24),
            "depthPpm": float(max(0.0, result.depth[best]) * 1e6),
            "blsPeakStatistic": float(power[best])}


def evidence(tic, kind, task, item, classification, diagnostics, controls,
             limitations, summary, next_steps, command):
    source = Path(__file__).resolve()
    return {
        "format": FORMAT,
        "protocolVersion": PROTOCOL,
        "dataKind": kind,
        "target": {"ticId": str(tic)},
        "taskKind": task,
        "inputs": [item],
        "method": {
            "code": {"name": source.name, "version": "1.0.0", "sha256": sha256_file(source)},
            "commands": ["python -m pip install -r requirements.txt", command],
            "detrending": "None beyond the archive's PDCSAP correction; normalize by the median after QUALITY=0 masking." if kind == "observational" else "None; deterministic synthetic flux is already normalized.",
            "search": "Astropy BoxLeastSquares power; 600 linearly spaced trial periods 1-10 days, fixed duration 0.12 day, objective=snr with no flux errors. Its unit-weighted peak is uncalibrated; no trial correction or detection threshold."
        },
        "observations": {"classification": classification, "events": []},
        "diagnostics": diagnostics,
        "controlResults": controls,
        "limitations": limitations,
        "summary": summary,
        "nextSteps": next_steps,
    }


def synthetic_flux(injected):
    rng = np.random.default_rng(SYNTHETIC_SEED)
    time = 2458000.0 + np.arange(27 * 48, dtype=float) / 48
    noise = rng.normal(0.0, 0.0007, len(time))
    flux = 1.0 + noise
    if injected:
        phase = ((time - (2458001.0) + SYNTHETIC_PERIOD / 2) % SYNTHETIC_PERIOD) - SYNTHETIC_PERIOD / 2
        flux[np.abs(phase) < DURATION_DAYS / 2] -= 0.005
    return time, flux


def run_self_test(args, command):
    out = prepare_out(args.out)
    time, flux = synthetic_flux(True)
    no_time, no_flux = synthetic_flux(False)
    input_path = out / "synthetic-input.csv"
    with input_path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(["bjd_tdb", "relative_flux"])
        writer.writerows(zip(time, flux))
    digest = sha256_file(input_path)
    injected_peak = search(time, flux)
    no_signal_peak = search(no_time, no_flux)
    recovered = (abs(injected_peak["periodDays"] - SYNTHETIC_PERIOD) / SYNTHETIC_PERIOD <= 0.01
                 and injected_peak["blsPeakStatistic"] > no_signal_peak["blsPeakStatistic"])
    item = {"uri": "urn:sha256:" + digest, "sha256": digest,
            "sector": 1, "timeSystem": "BJD_TDB",
            "fluxProvenance": "Local deterministic injection into Gaussian noise, seed 4206066; sector 1 is a synthetic label, not a TESS sector."}
    result = evidence(args.tic, "synthetic", "control-recovery", item, "inconclusive",
                      [{"name": "fixed-grid-bls", "status": "pass" if recovered else "fail",
                        "notes": "Offline code check only; see run-log.txt for peak values."},
                       {"name": "pixel-centroid", "status": "not-run", "notes": "No pixels exist in synthetic input."}],
                      [{"name": "injected-period-recovery", "status": "pass" if recovered else "fail",
                        "notes": "Injected 3.2-day, 5000-ppm box; require period error <=1% and BLS peak statistic above matched no-injection noise."}],
                      ["Synthetic injection is not TESS data, an astrophysical control, or a calibrated false-alarm test.",
                       "Only one deterministic injection and one matched noise realization were checked."],
                      "Offline smoke test of fixed-grid BLS on a declared synthetic injection; scientific classification remains inconclusive.",
                      ["Select independent public observational controls and preregister recovery criteria.",
                       "Assess noise-only false alarms and data gaps before any candidate threshold."], command)
    write_json(out / "evidence.json", result)
    log = {"utc": datetime.now(timezone.utc).isoformat(), "command": command,
           "argv": sys.argv[1:], "versions": versions(), "installedPackages": installed_packages(),
           "seed": SYNTHETIC_SEED, "injectedPeriodDays": SYNTHETIC_PERIOD,
           "injectedDepthPpm": 5000, "inputSha256": digest,
           "injectedPeak": injected_peak, "noInjectionPeak": no_signal_peak,
           "recoveredUnderDeclaredSmokeRule": recovered}
    write_json(out / "run-log.json", log)
    print("Evidence:", out / "evidence.json")
    print("Synthetic smoke control:", "pass" if recovered else "fail")
    return 0 if recovered else 1


def rows_for_tic(tic):
    from astroquery.mast import Observations

    rows = Observations.query_criteria(target_name=str(tic), obs_collection="TESS",
                                       dataproduct_type="timeseries")
    return [row for row in rows if str(row["target_name"]).strip().replace("TIC ", "") == str(tic)]


def row_sector(row):
    value = row["sequence_number"]
    if np.ma.is_masked(value):
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


def run_list(args):
    rows = rows_for_tic(args.tic)
    sectors = sorted({row_sector(row) for row in rows if row_sector(row) is not None})
    print(json.dumps({"ticId": str(args.tic), "availableSectors": sectors,
                      "observationRows": len(rows)}, indent=2))
    if not sectors:
        print("No matching public TESS time-series observations found; do not infer no planet.", file=sys.stderr)
        return 2
    return 0


def run_observational(args, command):
    from astroquery.mast import Observations

    out = prepare_out(args.out)
    matching = [row for row in rows_for_tic(args.tic) if row_sector(row) == args.sector]
    if not matching:
        raise RuntimeError("No matching time-series observation at that TIC and sector; run list first")
    products = Observations.get_product_list([str(row["obsid"]) for row in matching])
    usable = []
    for row in products:
        filename = str(row["productFilename"])
        uri = str(row["dataURI"])
        rights = str(row["dataRights"]) if "dataRights" in products.colnames else "PUBLIC"
        if filename.lower().endswith("_lc.fits") and uri.startswith("mast:") and rights == "PUBLIC":
            usable.append((uri, filename))
    if len(usable) != 1:
        raise RuntimeError(f"Expected exactly one public light-curve FITS product; found {len(usable)}. Inspect the MAST product list and declare a product selection rule before continuing.")
    uri, filename = usable[0]
    raw = out / filename
    status, message, _ = Observations.download_file(uri, local_path=str(raw))
    if status != "COMPLETE" or not raw.exists():
        raise RuntimeError(f"MAST download failed: {status}: {message}")
    with fits.open(raw, memmap=False) as hdus:
        primary, lightcurve = hdus[0].header, hdus[1]
        head = lightcurve.header
        actual_tic = str(primary.get("TICID", head.get("TICID", ""))).strip()
        actual_sector = int(primary.get("SECTOR", head.get("SECTOR", -1)))
        time_system = str(head.get("TIMESYS", primary.get("TIMESYS", ""))).upper()
        reference = float(head.get("BJDREFI", primary.get("BJDREFI", 0))) + float(head.get("BJDREFF", primary.get("BJDREFF", 0)))
        if actual_tic != str(args.tic) or actual_sector != args.sector:
            raise RuntimeError("Downloaded FITS header TIC/sector does not match the declared target")
        if time_system != "TDB" or abs(reference - 2457000.0) > 1e-6:
            raise RuntimeError(f"Unrecognized time system/reference: {time_system}, {reference}; inspect FITS before conversion")
        cols = lightcurve.data
        time = np.asarray(cols["TIME"], dtype=float) + reference
        flux = np.asarray(cols["PDCSAP_FLUX"], dtype=float)
        quality = np.asarray(cols["QUALITY"], dtype=int)
        camera = primary.get("CAMERA", head.get("CAMERA"))
        ccd = primary.get("CCD", head.get("CCD"))
    keep = np.isfinite(time) & np.isfinite(flux) & (flux > 0) & (quality == 0)
    if int(keep.sum()) < 100:
        raise RuntimeError("Fewer than 100 finite, positive, QUALITY=0 cadences; retain the file and report an inconclusive data audit")
    time, flux = time[keep], flux[keep]
    flux = flux / np.median(flux)
    peak = search(time, flux)
    digest = sha256_file(raw)
    item = {"uri": uri, "sha256": digest, "sector": args.sector,
            "timeSystem": "BJD_TDB", "fluxProvenance": "MAST TESS light-curve FITS PDCSAP_FLUX; finite positive cadences with QUALITY=0; median normalized."}
    result = evidence(args.tic, "observational", "transit-search", item, "inconclusive",
                      [{"name": "fixed-grid-bls", "status": "pass", "notes": "A descriptive maximum was computed on the retained cadences; see run-log.json."},
                       {"name": "odd-even-depth", "status": "not-run", "notes": "Starter does not fit separate odd/even events."},
                       {"name": "secondary-eclipse", "status": "not-run", "notes": "Starter does not inspect phase 0.5."},
                       {"name": "pixel-centroid", "status": "not-run", "notes": "No target pixel or nearby-source analysis."},
                       {"name": "trial-corrected-false-alarm", "status": "not-run", "notes": "No noise or multiple-trial calibration."}],
                      [{"name": "observational-known-planet", "status": "not-run", "notes": "No independently selected known-planet control in this run."},
                       {"name": "observational-false-positive", "status": "not-run", "notes": "No independently selected known false-positive control in this run."}],
                      ["One sector and one archive product only; other sectors or flux reductions may differ.",
                       "BLS maximum was selected after scanning 600 trial periods; no calibrated significance or uncertainty is available.",
                       "No odd/even, secondary, centroid, contamination, or stellar-variability vetting was performed."],
                      "Exploratory single-sector TESS BLS scan retained a descriptive peak; signal status is inconclusive.",
                      ["Run predeclared observational controls and injection recovery on the same pipeline.",
                       "Inspect sectors, pixels, aliases and false-positive diagnostics before interpreting a signal."], command)
    write_json(out / "evidence.json", result)
    write_json(out / "run-log.json", {"utc": datetime.now(timezone.utc).isoformat(),
               "command": command, "argv": sys.argv[1:], "versions": versions(),
               "installedPackages": installed_packages(), "mastUri": uri,
               "productFilename": filename, "fileSha256": digest, "ticId": str(args.tic),
               "sector": args.sector, "camera": camera, "ccd": ccd,
               "timeSystem": time_system, "bjdReference": reference,
               "keptQualityZeroCadences": int(keep.sum()), "totalCadences": int(len(keep)),
               "peak": peak})
    print("Evidence:", out / "evidence.json")
    print("Descriptive BLS peak:", json.dumps(peak))
    return 0


def main():
    def tic_id(value):
        if not value.isascii() or not value.isdigit() or value.startswith("0") or len(value) > 12:
            raise argparse.ArgumentTypeError("TIC ID must be 1-12 positive decimal digits")
        return value

    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    smoke = commands.add_parser("self-test", help="offline deterministic injection and no-injection smoke check")
    smoke.add_argument("--tic", type=tic_id, default="4206066")
    smoke.add_argument("--out", required=True)
    inventory = commands.add_parser("list", help="list matching public TESS observation sectors")
    inventory.add_argument("--tic", type=tic_id, default="4206066")
    run = commands.add_parser("run", help="download one selected MAST FITS and run exploratory BLS")
    run.add_argument("--tic", type=tic_id, default="4206066")
    run.add_argument("--sector", type=int, required=True)
    run.add_argument("--out", required=True)
    args = parser.parse_args()
    if getattr(args, "sector", 1) < 1:
        parser.error("--sector must be positive")
    quote = subprocess.list2cmdline if sys.platform == "win32" else shlex.join
    command = "python " + quote(["exoplanet_starter.py", *sys.argv[1:]])
    out_value = getattr(args, "out", None)
    if out_value and Path(out_value).exists() and (not Path(out_value).is_dir() or any(Path(out_value).iterdir())):
        print(f"No evidence written: output directory is not empty: {out_value}", file=sys.stderr)
        return 2
    try:
        if args.action == "self-test":
            return run_self_test(args, command)
        if args.action == "list":
            return run_list(args)
        return run_observational(args, command)
    except Exception as error:
        if out_value:
            out = Path(out_value)
            if out.is_dir() and not (out / "evidence.json").exists() and not (out / "failure.json").exists():
                write_json(out / "failure.json", {"utc": datetime.now(timezone.utc).isoformat(),
                           "command": command, "argv": sys.argv[1:],
                           "errorType": type(error).__name__, "error": str(error),
                           "outcome": "no evidence written",
                           "retainedFiles": [path.name for path in out.iterdir()]})
        print(f"No evidence written: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
