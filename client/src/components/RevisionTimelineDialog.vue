<template>
  <el-dialog
    :model-value="modelValue"
    title="🕑 生产记录修订时间线"
    width="640px"
    destroy-on-close
    @update:model-value="v => emit('update:modelValue', v)"
    @open="load"
  >
    <div v-loading="loading">
      <div v-if="data" style="margin-bottom: 16px; padding: 10px 14px; background: #f9fafb; border-radius: 8px; font-size: 13px;">
        工单号 <strong>{{ data.order_no }}</strong>
        <el-divider direction="vertical" />
        当前版本
        <el-tag size="small" :type="data.current_version > 0 ? 'warning' : 'info'">v{{ data.current_version }}</el-tag>
        <span v-if="data.last_revised_at" style="margin-left: 8px; color: #6b7280;">
          最近修订 {{ formatTime(data.last_revised_at) }}
        </span>
      </div>

      <el-timeline v-if="data">
        <el-timeline-item
          v-for="node in data.timeline"
          :key="node.version_no"
          :type="node.version_no === 0 ? 'primary' : 'warning'"
          :timestamp="formatTime(node.operated_at)"
          placement="top"
        >
          <el-card shadow="never" class="revision-card">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;">
              <strong>{{ node.title }}</strong>
              <el-tag size="small" :type="node.version_no === 0 ? 'info' : 'warning'">v{{ node.version_no }}</el-tag>
            </div>
            <el-descriptions :column="3" size="small" border>
              <el-descriptions-item label="完成数">{{ node.completed_qty }}</el-descriptions-item>
              <el-descriptions-item label="不良数">{{ node.defect_qty }}</el-descriptions-item>
              <el-descriptions-item label="工时(h)">{{ node.work_hours }}</el-descriptions-item>
              <el-descriptions-item label="不良原因" :span="3">{{ node.defect_reason || '—' }}</el-descriptions-item>
              <el-descriptions-item label="备注" :span="3">{{ node.remark || '—' }}</el-descriptions-item>
            </el-descriptions>
            <div style="margin-top: 8px; font-size: 12px; color: #6b7280;">
              <template v-if="node.version_no === 0">
                上报人：{{ node.operator_name }}
              </template>
              <template v-else>
                批准人：{{ node.approver_name }}
                <span v-if="node.reason" style="margin-left: 10px;">纠错原因：{{ node.reason }}</span>
              </template>
            </div>
            <div v-if="node.order_snapshot" style="margin-top: 8px; padding: 8px 10px; background: #fffbeb; border-radius: 6px; font-size: 12px;">
              <strong>工单重算：</strong>
              完成数 {{ node.order_snapshot.old_completed_qty }} →
              <strong :class="{ 'rev-change': node.order_snapshot.old_completed_qty !== node.order_snapshot.new_completed_qty }">
                {{ node.order_snapshot.new_completed_qty }}
              </strong>，
              不良数 {{ node.order_snapshot.old_defect_qty }} →
              <strong :class="{ 'rev-change': node.order_snapshot.old_defect_qty !== node.order_snapshot.new_defect_qty }">
                {{ node.order_snapshot.new_defect_qty }}
              </strong>，
              工时 {{ node.order_snapshot.old_work_hours }} →
              <strong :class="{ 'rev-change': Number(node.order_snapshot.old_work_hours) !== Number(node.order_snapshot.new_work_hours) }">
                {{ node.order_snapshot.new_work_hours }}
              </strong>，
              状态 {{ statusText(node.order_snapshot.old_status) }} →
              <strong :class="{ 'rev-change': node.order_snapshot.old_status !== node.order_snapshot.new_status }">
                {{ statusText(node.order_snapshot.new_status) }}
              </strong>
            </div>
          </el-card>
        </el-timeline-item>
      </el-timeline>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref } from 'vue'
import { getRecordTimeline } from '@/api/modules'

const props = defineProps({
  modelValue: Boolean,
  recordId: [Number, String]
})
const emit = defineEmits(['update:modelValue'])

const loading = ref(false)
const data = ref(null)

const statusText = (s) => ['待生产', '生产中', '已完成', '已暂停'][s] || '未知'
const formatTime = (t) => {
  if (!t) return '-'
  const d = new Date(t)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const load = async () => {
  if (!props.recordId) return
  loading.value = true
  try {
    const res = await getRecordTimeline(props.recordId)
    data.value = res.data
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.revision-card { border: 1px solid #f0f0f0; }
.rev-change { color: #b45309; }
</style>
