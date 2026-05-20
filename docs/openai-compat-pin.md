# OpenAI Compatibility Pin (Class B.1)

**Status:** Placeholder — populated at first B.1 audit per ADR 0006 §"Class B audit cadence".

This file is the Class B.1 counterpart to the Class A `cli.js` audit pin in `ALIGNMENT.md` §"Golden Reference". When the first annual alignment audit covers Class B (per `ALIGNMENT.md` §"Annual Alignment Audit"), this file will be populated with:

- The OpenAI `/v1/chat/completions` specification snapshot date being audited against (and the source URL the snapshot was taken from).
- The list of B.1 endpoints (currently `/v1/chat/completions`, `/v1/models`) and, for each one, the specific OpenAI spec fields and behaviours it honors.
- Drift detection notes for any OpenAI spec changes since the previous audit, and any OCP code changes required to track those changes.

Until populated, this file's existence is only a forward reference so that the link in `ALIGNMENT.md` does not 404. The actual audit procedure is defined in `ALIGNMENT.md` §"Annual Alignment Audit" (Class B scope) and ADR 0006 §"Class B audit cadence".
