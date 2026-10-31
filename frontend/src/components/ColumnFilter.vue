<script setup lang="ts">
import InputText from 'openvue/inputtext'
import MultiSelect from 'openvue/multiselect'
import Select from 'openvue/select'

import type { FilterOption } from '../lists'

// The filter under a column of a list (lists.ts): a list of choices (one, or several with `multiple`), else free text.
// Given the filter model and the callback of the column (slot « filter » of DataTable).

const props = defineProps<{ model: { value: unknown }, apply: () => void, options?: FilterOption[], multiple?: boolean }>()

function change(value: unknown) {
  // eslint-disable-next-line vue/no-mutating-props -- the filter model of DataTable is meant to be changed in place
  props.model.value = value === '' ? null : value
  props.apply()
}
</script>

<template>
  <MultiSelect
    v-if="options && multiple" :model-value="model.value" :options="options" option-label="label" option-value="value"
    placeholder="Tous" :max-selected-labels="1" selected-items-label="{0} choisis" size="small" class="column-filter"
    @update:model-value="change"
  />
  <Select
    v-else-if="options" :model-value="model.value" :options="options" option-label="label" option-value="value"
    placeholder="Tous" show-clear size="small" class="column-filter" @update:model-value="change"
  />
  <!-- size 1: no natural width of 20 characters, the column keeps the width of its content -->
  <InputText
    v-else :model-value="(model.value as string | null) ?? ''" size="small" :pt="{ root: { size: 1 } }"
    class="column-filter" @update:model-value="change"
  />
</template>
