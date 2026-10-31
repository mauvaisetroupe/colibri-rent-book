import type { DataTableFilterMeta } from 'openvue/datatable'

// The lists of the application in OpenVue tables (DataTable): a filter under each column, on the fields as the API gives
// them. Their state (filters, sort) is kept for the session of the tab (« state-storage »): back from an invoice, the
// list is as it was left.

/** The filters of a table: one per column, by field. */
export type Filters = DataTableFilterMeta

/** A choice of a list filter: the label shown, the value of the field. */
export type FilterOption = { label: string, value: string }

/** Free text: the rows whose field contains it, case ignored. */
export const contains = (value: string | null = null) => ({ value, matchMode: 'contains' })

/** One choice of a list: the rows whose field is that value. */
export const equals = (value: string | null = null) => ({ value, matchMode: 'equals' })

/** Several choices of a list: the rows whose field is one of them (none chosen: every row). */
export const anyOf = (value: string[] = []) => ({ value, matchMode: 'in' })

/** The choices of a field from its labels by value (ENERGIES, STATUTS…). */
export const optionsOf = (labels: Record<string, string>): FilterOption[] =>
  Object.entries(labels).map(([value, label]) => ({ label, value }))

/** The distinct values of a field, sorted, each shown as it is. */
export const distinctOptions = (values: (string | null | undefined)[]): FilterOption[] =>
  [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, 'fr')).map((v) => ({ label: v, value: v }))

/**
 * The filters restored from the session, with those of columns added since (else such a column has no filter field).
 * Given to `filters` on the « state-restore » event of the table.
 */
export const withDefaults = (defaults: Filters, restored: Filters | undefined): Filters => ({ ...defaults, ...restored })

/** Where the state of a table is kept, one key per list. */
export const stateKey = (list: string) => `colibri-list-${list}`

/** A table as its ref gives it: the rows it shows, filtered and sorted (`processedData`), for counts and totals. */
export type FilteredTable<T> = { processedData: T[] } | null
