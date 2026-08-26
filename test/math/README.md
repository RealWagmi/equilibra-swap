# Math Simulation Gate (TypeScript)

This directory contains the pre-implementation math simulation gate implemented in TypeScript for Hardhat workflows.

## Purpose

The simulation suite provides deterministic, high-precision checks for:

- split-vs-one-shot execution consistency,
- roundtrip stability under zero-fee assumptions,
- rounding stress behavior on small-value inputs.

## Why TypeScript

The project standard is Hardhat-first testing. All simulation gates are integrated into the normal `npm test` flow, so there is no separate Python/Notebook runtime dependency.

## Execution

The simulation tests run automatically through:

- `npm test`

and are located in:

- `test/math/HighPrecisionHarness.test.ts`

