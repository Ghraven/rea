# Process Monitor export Evidence (#3766)

## Outcome and scope

Analysts receive Process Monitor captures that someone else exported. Add a
read-only `inspect_procmon_export` tool and `inspect-procmon-export` CLI command
that read one caller-selected XML or CSV export and return its events as inline
Evidence through one shared service.

Inputs: an absolute local `path`, `format` (`auto`, `xml` or `csv`; default
`auto`), and `event_offset`/`event_limit` paging (defaults 0 and 50; a null
limit returns all remaining events within the output budget).

## Event projection

Each event keeps its 1-based source ordinal and the exact text of Time of Day,
Process Name, PID, Operation, Path, Result and Detail. Other simple columns are
kept in source order as `{column, value}` entries under `additional`. A projected column absent from the
export is listed in `missing_columns` and is null in every event; an empty cell
stays an empty string. In XML, field names spell spaces as underscores, a field
missing from one event is null for that event, and fields with child elements
(stacks) are listed in `omitted_nested_fields` and not projected. The XML
process list is not read.

Source identity: path, SHA-256, byte length, detected format, encoding, byte
order mark and the header or first-seen field order.

## Coverage

Parsing is deterministic and in source order. CSV follows RFC 4180 with CRLF or
LF rows; XML is read with a streaming parser and DTDs are rejected. A row with
the wrong field count, a quote in an unquoted field, an unclosed quote, or XML
that stops being well-formed ends reading: earlier events are returned with
`coverage: partial`, the reason (`truncated` or `malformed`), a message and the
stopping line. Files that are not Process Monitor exports fail as invalid input.
Unsupported encodings and DTDs fail as unsupported targets.

## Authority and limits

Reads only the selected file through the stable artifact reader. No Process
Monitor process, driver, live tracing, PML decoding or bundled binaries.
Execution authority is not applicable: the input is a recorded capture.
Input is bounded to 128 MiB, the returned page to an 8 MiB inline budget
(admitted per event before retention), and columns to 1024.

## Non-goals

Live ETW collection (#2689), PML parsing, and interpreting what events mean.
