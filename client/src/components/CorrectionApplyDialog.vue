<template>
  <el-dialog
    :model-value="modelValue"
    title="📝 生产记录纠错申请"
    width="560px"
    destroy-on-close
    @update:model-value="v => emit('update:modelValue', v)"
    @open="handleOpen"
  >
    <el-alert
      type="info"
      :closable="false"
      show-icon
      style="margin-bottom: 16px;"
      title="提交后原记录不会被直接修改，需主管审批；审批通过后生成不可变修订版本并自动重算工单数据。" />

    <div v-if="record" style="margin-bottom: 16px; padding: 12px 16px; background: #f9fafb; border-radius: 8px; font-size: 13px;">
      <div style="display:flex; justify-content:space-between; margin-bottom: 6px;">
        <strong>{{ record.order_no }}</strong>
        <el-tag size="small" type="info">上报时间 {{ formatTime(record.created_at) }}</el-tag>
      </div>
      <div style="color: #6b7280;">
        {{ record.product_name }} <span v-if="record.product_model">({{ record.product_model }})</span>
      </div>
    </div>

    <el-form :model="form" :rules="rules" ref="formRef" label-width="100px">
      <el-form-item label="完成数" prop="corrected_completed_qty">
        <el-input-number v-model="form.corrected_completed_qty" :min="0" :max="99999" style="width: 100%;" />
        <div v-if="diff('completed_qty')" class="diff-hint">
          原值 {{ record?.completed_qty }} → 新值 <strong>{{ form.corrected_completed_qty }}</strong>
        </div>
      </el-form-item>
      <el-form-item label="不良数" prop="corrected_defect_qty">
        <el-input-number v-model="form.corrected_defect_qty" :min="0" :max="9999" style="width: 100%;" />
        <div v-if="diff('defect_qty')" class="diff-hint">
          原值 {{ record?.defect_qty }} → 新值 <strong>{{ form.corrected_defect_qty }}</strong>
        </div>
      </el-form-item>
      <el-form-item label="工时(h)" prop="corrected_work_hours">
        <el-input-number v-model="form.corrected_work_hours" :min="0" :max="24" :step="0.5" :precision="2" style="width: 100%;" />
        <div v-if="diff('work_hours')" class="diff-hint">
          原值 {{ record?.work_hours }} → 新值 <strong>{{ form.corrected_work_hours }}</strong>
        </div>
      </el-form-item>
      <el-form-item label="不良原因">
        <el-input v-model="form.corrected_defect_reason" type="textarea" :rows="2"
          :placeholder="record?.defect_reason ? `原：${record.defect_reason}` : '原：（空）'" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.corrected_remark" type="textarea" :rows="2"
          :placeholder="record?.remark ? `原：${record.remark}` : '原：（空）'" />
      </el-form-item>
      <el-form-item label="纠错原因" prop="reason">
        <el-input v-model="form.reason" type="textarea" :rows="3" maxlength="500" show-word-limit
          placeholder="请详细说明为什么需要纠错（必填）" />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">提交申请</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { createCorrection } from '@/api/modules'

const props = defineProps({
  modelValue: Boolean,
  // 生产记录行（含 completed_qty/defect_qty/work_hours/defect_reason/remark/order_no/created_at）
  record: Object
})
const emit = defineEmits(['update:modelValue', 'submitted'])

const formRef = ref(null)
const submitting = ref(false)
const form = reactive({
  corrected_completed_qty: 0,
  corrected_defect_qty: 0,
  corrected_work_hours: 0,
  corrected_defect_reason: '',
  corrected_remark: '',
  reason: ''
})

const rules = {
  reason: [{ required: true, message: '请填写纠错原因', trigger: 'blur' }]
}

const num = (v) => Number(v || 0)
const diff = (field) => {
  if (!props.record) return false
  if (field === 'defect_reason' || field === 'remark') return false
  return num(props.record[field]) !== num(form[field])
}

const formatTime = (t) => {
  if (!t) return '-'
  const d = new Date(t)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const resetForm = () => {
  if (!props.record) return
  form.corrected_completed_qty = num(props.record.completed_qty)
  form.corrected_defect_qty = num(props.record.defect_qty)
  form.corrected_work_hours = num(props.record.work_hours)
  form.corrected_defect_reason = props.record.defect_reason || ''
  form.corrected_remark = props.record.remark || ''
  form.reason = ''
  formRef.value?.clearValidate?.()
}

const handleOpen = resetForm
watch(() => props.record, resetForm)

const submit = async () => {
  await formRef.value.validate()
  if (
    num(form.corrected_completed_qty) === num(props.record.completed_qty) &&
    num(form.corrected_defect_qty) === num(props.record.defect_qty) &&
    num(form.corrected_work_hours) === num(props.record.work_hours) &&
    (form.corrected_defect_reason || '') === (props.record.defect_reason || '') &&
    (form.corrected_remark || '') === (props.record.remark || '')
  ) {
    ElMessage.warning('修正后的内容与原记录完全一致，无需提交纠错')
    return
  }
  submitting.value = true
  try {
    const res = await createCorrection({
      record_id: props.record.id,
      corrected_completed_qty: form.corrected_completed_qty,
      corrected_defect_qty: form.corrected_defect_qty,
      corrected_work_hours: form.corrected_work_hours,
      corrected_defect_reason: form.corrected_defect_reason || '',
      corrected_remark: form.corrected_remark || '',
      reason: form.reason
    })
    ElMessage.success(res.message || '纠错申请已提交')
    emit('update:modelValue', false)
    emit('submitted', res.data)
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.diff-hint { font-size: 12px; color: #92400e; margin-top: 4px; }
</style>
