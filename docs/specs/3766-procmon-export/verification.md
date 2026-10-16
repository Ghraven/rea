# Verification (#3766)

Hand-built fixtures in `tests/fixtures/procmon/` follow the Process Monitor
CSV (BOM, quoted header, CRLF rows) and XML (`procmon`/`processlist`/
`eventlist`) layouts. They were written by hand, not exported from a running
Process Monitor; real exports from Process Monitor itself were not checked.

- `tests/acceptance/procmonExportCli.test.ts`: CSV quoting and CRLF, XML
  absent and nested fields, paging with offset/limit and all events, missing
  columns, truncated and malformed CSV, truncated XML, and non-Procmon inputs,
  through the public CLI.
- `tests/boundary/mcp/procmonExportMcp.test.ts`: advertised annotations, MCP
  paging over the XML fixture, BOM-marked UTF-16 CSV, relative-path and DTD
  rejection.
- `tests/boundary/mcp/toolSchemaValidity.test.ts` and
  `src/contracts/toolEffects.test.ts` cover the advertised schemas and effects.

Token usage, elapsed time and peak memory on large real exports were not
measured.
