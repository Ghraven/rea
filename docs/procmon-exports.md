# Process Monitor exports

`inspect_procmon_export` reads events from a Process Monitor capture that
someone already exported as XML or CSV. Use it when an analyst hands you a
saved Procmon export and you need its file, registry, process and network
events as Evidence. It only reads the selected file: it does not start Process
Monitor, load its driver, trace live activity or decode native `.PML` files.
Live Windows tracing is tracked separately in
[#2689](https://github.com/morluto/rea/issues/2689).

```sh
rea inspect-procmon-export /artifacts/procmon.csv --json
rea inspect-procmon-export /artifacts/procmon.xml --event_offset 100 --event_limit 100 --json
```

The corresponding MCP call is:

```json
{
  "name": "inspect_procmon_export",
  "arguments": {
    "path": "/artifacts/procmon.xml",
    "event_offset": 100,
    "event_limit": 100
  }
}
```

## Formats

`format` defaults to `auto`, which selects XML when the first non-whitespace
character is `<` and CSV otherwise. Pass `xml` or `csv` to require one; on
the CLI this is `--export_format`, because `--format` selects the output format.

- **CSV**: a header row followed by one row per event, as written by
  Process Monitor's _Save > CSV_. Quoted fields, doubled quotes, embedded line
  breaks and CRLF or LF row endings are supported.
- **XML**: a `procmon` root with an `eventlist` of `event` elements, as written
  by _Save > XML_. Each simple child of an `event` is one field; XML field names
  spell spaces as underscores (`Process_Name`); CSV headers must use the
  names with spaces. Fields with child elements, such
  as `stack`, are listed in `omitted_nested_fields` and not projected. The
  `processlist` section is not read. Documents with a DTD are rejected.

Both formats must be UTF-8 (with or without a byte order mark) or BOM-marked
UTF-16. Re-save other encodings as UTF-8.

## Events

Each event keeps its 1-based `ordinal` in the export and the text of these
columns exactly as exported: `time_of_day`, `process_name`, `pid`,
`operation`, `path`, `result` and `detail`. Other columns, such as `TID` or
`Sequence`, are kept in source order under `additional` as
`{ "column", "value" }` entries.

A column that never appears in the export is listed in `missing_columns`, and
its event field is `null`. An empty cell stays an empty string. In XML, an event
without one of the fields also has `null` for it.

`source` reports the detected format, encoding, byte order mark and the column
order (the CSV header, or XML field names in first-seen order). `artifact`
reports the path, SHA-256 and byte length of the export.

## Paging and limits

`event_offset` (default 0) skips events in source order and `event_limit`
(default 50) bounds the page; `null`, or `--all_events` on the CLI, returns all
remaining events. `output_window` reports how many events were examined and
whether more remain.

The export may be at most 128 MiB. The returned page, column names and other
report metadata must fit the 8 MiB report budget; the Evidence envelope around
the report adds its own metadata, as for other REA tools. Sizes are counted
before anything is built, and a larger report fails with a resource error that
asks for a smaller `event_limit`. A CSV row stops being read once it has more
fields than the header (at most 1024 columns). Parsing yields between slices,
so a call can be cancelled while a large export is read.

## Partial exports

A truncated or malformed export does not fail the call. Events read before the
problem are returned, and `coverage` is `partial` with the `reason`
(`truncated` or `malformed`), a message and the source line where reading
stopped. A CSV row with the wrong number of fields, a quote in an unquoted
field, an unclosed quote, or XML that stops being well-formed all end reading.
An export whose last character is cut off is decoded up to that character
and reported as `truncated`.
Events after that point are not examined, so their absence is not established.

A file that is not a Process Monitor export — an empty file, a CSV header that
names none of the columns above, repeated or empty CSV column names, or XML
without a `procmon` root and `eventlist` — is rejected as invalid input.
