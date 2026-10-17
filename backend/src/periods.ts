// The one place where SQL half-open dateranges meet the inclusive dates of the API (CLAUDE.md):
// a line « du 01/01 au 31/01 » is stored '[2025-01-01,2025-02-01)'. An open stay has an infinite upper bound,
// read back as a null end date.

/** SELECT fragment: inclusive bounds of a daterange column, as ISO text (end null when infinite). */
export const inclusiveBounds = (column: string, start = 'debut', end = 'fin') =>
  `lower(${column})::text AS ${start}, (upper(${column}) - 1)::text AS ${end}`

/** SQL expression: daterange from two inclusive ISO date parameters (a null end gives an open range). */
export const inclusiveRange = (start: string, end: string) => `daterange(${start}::date, ${end}::date, '[]')`
