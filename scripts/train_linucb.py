#!/usr/bin/env python3
"""Offline LinUCB policy training for the Flaxia Arcade recommender.

Reads the anonymized dwell dataset (a local JSONL artifact produced by
functions/lib/dataset-export.ts, or a HuggingFace dataset), fits a ridge
regression of the reward `label` on the JL-projected content embeddings, and
writes a BanditPrior (prior.json) that can be deployed to KV as
`arcade:bandit:prior` via scripts/deploy-prior.mjs.

The random projection reproduces functions/lib/linucb.ts exactly (mulberry32
PRNG + deterministic +/-1 JL rows), so the trained theta lives in the same
projected feature space the online bandit serves in. Changing --seed/--dim/
--src-dim after the prior is deployed invalidates it.

Usage:
  python3 scripts/train_linucb.py --dataset path/to/arcade-dwell-<ts>.jsonl [options]
  python3 scripts/train_linucb.py --dataset youruser/flaxia-arcade-dwell [options]

Options (mirror arcade:bandit:config):
  --dim 64             projected dimension (must match the online config)
  --seed 20260701      projection seed (must match the online config)
  --src-dim 1024       source embedding dimension
  --ridge-lambda 1.0   ridge regularization for the regression
  --prior-strength 1.0 lambda0 of the deployed prior (anchoring strength)
  --val-fraction 0.2   held-out fraction for the validation split
  --out prior.json     output path for the BanditPrior

Requires numpy. The `datasets` package is only needed for HF sources.
"""

import argparse
import hashlib
import json
import os
import sys
import time

MASK32 = 0xFFFFFFFF


def _signed(x: int) -> int:
    x &= MASK32
    return x - 0x100000000 if x >= 0x80000000 else x


def _imul(a: int, b: int) -> int:
    return _signed((a & MASK32) * (b & MASK32))


def mulberry32(seed: int):
    """Bit-exact port of the mulberry32 PRNG used by functions/lib/linucb.ts."""
    a = seed & MASK32

    def rand() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & MASK32
        t = _imul(_signed((a & MASK32) ^ ((a & MASK32) >> 15)), 1 | _signed(a))
        old_t = t
        t = (
            (_signed(t) + _imul(_signed((t & MASK32) ^ ((t & MASK32) >> 7)), 61 | _signed(t)))
            ^ _signed(old_t)
        ) & MASK32
        return ((_signed(t) ^ ((t & MASK32) >> 14)) & MASK32) / 4294967296

    return rand


def create_projection(src_dim: int, dst_dim: int, seed: int):
    rand = mulberry32(seed)
    return [[1 if rand() < 0.5 else -1 for _ in range(src_dim)] for _ in range(dst_dim)]


def project(vec, proj):
    out = []
    for row in proj:
        acc = 0
        for i, coeff in enumerate(row):
            acc += coeff * (vec[i] if i < len(vec) else 0)
        out.append(acc)
    return out


def project_many(embeddings, proj):
    """Column-major accumulation avoids per-row Python loops over src_dim."""
    src_dim = len(proj[0])
    dst_dim = len(proj)
    out = [[0.0] * dst_dim for _ in range(len(embeddings))]
    for j in range(dst_dim):
        row = proj[j]
        for n, emb in enumerate(embeddings):
            acc = 0
            for i in range(src_dim):
                acc += row[i] * emb[i]
            out[n][j] = acc
    return out


def load_records(local_path: str):
    records = []
    with open(local_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            records.append(row)
    return records


def load_records_hf(dataset_ref: str):
    try:
        from datasets import load_dataset
    except ImportError as exc:
        sys.exit(f"`datasets` is required for HuggingFace sources: {exc}")
    ds = load_dataset(dataset_ref, split="train")
    return [dict(row) for row in ds]


def numeric(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # drop NaN


def check_projection(src_dim: int, dst_dim: int, seed: int) -> None:
    """Print reference values to cross-check against the TypeScript impl."""
    proj = create_projection(src_dim, dst_dim, seed)
    out = project([1.0] * src_dim, proj)
    print(f"check: row0={proj[0][:8]}")
    print(f"check: row1={proj[1][:8]}")
    print(f"check: firsts={[r[0] for r in proj]}")
    print(f"check: proj(all-ones)={out[:8]}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, help="local JSONL path or HuggingFace dataset id")
    parser.add_argument("--dim", type=int, default=64)
    parser.add_argument("--seed", type=int, default=20260701)
    parser.add_argument("--src-dim", type=int, default=1024)
    parser.add_argument("--ridge-lambda", type=float, default=1.0)
    parser.add_argument("--prior-strength", type=float, default=1.0)
    parser.add_argument("--val-fraction", type=float, default=0.2)
    parser.add_argument("--out", default="prior.json")
    parser.add_argument(
        "--check-projection",
        action="store_true",
        help="print projection reference values and exit (for Node cross-check)",
    )
    args = parser.parse_args()

    if args.check_projection:
        check_projection(args.src_dim, args.dim, args.seed)
        return 0

    try:
        import numpy as np
    except ImportError as exc:
        sys.exit(f"numpy is required: {exc}")

    if os.path.exists(args.dataset):
        records = load_records(args.dataset)
        source = args.dataset
    else:
        records = load_records_hf(args.dataset)
        source = args.dataset

    embeddings = []
    labels = []
    for row in records:
        emb = row.get("post_embedding")
        label = numeric(row.get("label"))
        if not emb or len(emb) != args.src_dim or label is None:
            continue
        embeddings.append([float(v) if v is not None else 0.0 for v in emb])
        labels.append(label)

    if len(embeddings) < 2:
        sys.exit(f"Not enough usable records (got {len(embeddings)}); nothing to train on.")

    print(f"source: {source}")
    print(f"loaded records: {len(records)}, usable after filter: {len(embeddings)}")

    proj = create_projection(args.src_dim, args.dim, args.seed)
    X = np.array(project_many(embeddings, proj), dtype=np.float64)
    y = np.array(labels, dtype=np.float64)

    rng = np.random.default_rng(0)
    idx = rng.permutation(X.shape[0])
    split = int(X.shape[0] * (1.0 - args.val_fraction))
    train_idx, val_idx = idx[:split], idx[split:]
    X_tr, y_tr = X[train_idx], y[train_idx]
    X_val, y_val = X[val_idx], y[val_idx]

    d = X_tr.shape[1]
    A = X_tr.T @ X_tr + args.ridge_lambda * np.eye(d)
    b = X_tr.T @ y_tr
    theta = np.linalg.solve(A, b)

    pred_tr = X_tr @ theta
    pred_val = X_val @ theta

    def rmse(p, t):
        return float(np.sqrt(np.mean((p - t) ** 2)))

    print(f"train rmse: {rmse(pred_tr, y_tr):.5f} ({train_idx.size} rows)")
    print(f"val   rmse: {rmse(pred_val, y_val):.5f} ({val_idx.size} rows)")

    prior = {
        "v": 1,
        "dim": args.dim,
        "seed": args.seed,
        "srcDim": args.src_dim,
        "theta": [round(float(v), 9) for v in theta],
        "lambda0": args.prior_strength,
        "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "records": len(embeddings),
    }

    # Include a fingerprint so deploy-time validation can detect stale priors.
    fp = hashlib.sha256(
        json.dumps({"v": 1, "dim": args.dim, "seed": args.seed, "srcDim": args.src_dim, "theta": prior["theta"]}).encode()
    ).hexdigest()[:16]
    prior["fingerprint"] = fp

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(prior, fh, indent=2)

    print(f"\nwrote {args.out} ({len(prior['theta'])}-d theta, records={len(embeddings)})")
    print("suggested bandit config (deploy alongside the prior):")
    print(
        json.dumps(
            {
                "enabled": True,
                "alpha": 0.6,
                "dim": args.dim,
                "srcDim": args.src_dim,
                "lambda": 0.6,
                "seed": args.seed,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
