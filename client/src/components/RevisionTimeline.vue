<template>
  <div v-loading="loading">
    <el-timeline v-if="record" style="padding-left: 4px;">
      <el-timeline-item type="primary" :hollow="false" :timestamp="formatTime(record.created_at)" placement="top">
        <div style="font-weight: 600; margin-bottom: 6px;">
          原始记录
          <el-tag v-if="revisions.length === 0" size="small" type="success" style="margin-left: 6px;">当前生效</el-tag>
        </div>
        <div style="font-size: 13px; color: #374151;">
          完成 <strong>{{ record.completed_qty }}</strong>
          · 不良 <strong :style="{ color: record.defect_qty > 0 ? '#dc2626' : '#374151' }">{{ record.defect_qty }}</strong>
          · 工时 <strong>{{ record.work_hours }}h</strong>
        </div>
        <div v-if="record.defect_reason" style="font-size: 12px; color: #6b7280; margin-top: 2px;">不良原因: {{ record.defect_reason }}</div>
        <div v-if="record.remark" style="font-size: 12px; color: #6b7280; margin-top: 2px;">备注: {{ record.remark }}</div>
        <div style="font-size: 12px; color: #9ca3af; margin-top: 4px;">上报人: {{ record.user_name }}</div>
      </el-timeline-item>

      <el-timeline-item
        v-for="rev in revisions"
        :key="rev.id"
        type="warning"
        :timestamp="formatTime(rev.created_at)"
        placement="top"
      >
        <div style="font-weight: 600; margin-bottom: 6px;">
          修订版本 v{{ rev.revision_no }}
          <el-tag v-if="rev.revision_no === revisions.length" size="small" type="success" style="margin-left: 6px;">当前生效</el-tag>
          <el-tag size="small" type="info" style="margin-left: 6px;">{{ rev.request_no }}</el-tag>
        </div>
        <div style="font-size: 13px; color: #374151;">
          完成 <strong>{{ rev.completed_qty }}</strong>
          · 不良 <strong :style="{ color: rev.defect_qty > 0 ? '#dc2626' : '#374151' }">{{ rev.defect_qty }}</strong>
          · 工时 <strong>{{ rev.work_hours }}h</strong>
        </div>
        <div v-if="rev.defect_reason" style="font-size: 12px; color: #6b7280; margin-top: 2px;">不良原因: {{ rev.defect_reason }}</div>
        <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">
          申请人: {{ rev.applicant_name }} · 纠错原因: {{ rev.reason }}
        </div>
        <div style="font-size: 12px; color: #6b7280; margin-top: 2px;">
          审批人: {{ rev.changed_by_name }} · {{ formatTime(rev.reviewed_at) }}
          <span v-if="rev.review_comment"> · 审批意见: {{ rev.review_comment }}</span>
        </div>
      </el-timeline-item>
    </el-timeline>
    <div v-if="!loading && !record" style="text-align: center; padding: 40px; color: #9ca3af;">暂无数据</div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { getRecordRevisions } from '@/api/modules'

const props = defineProps({
  recordId: { type: Number, default: null }
})

const loading = ref(false)
const record = ref(null)
const revisions = ref([])

const formatTime = (t) => {
  if (!t) return '-'
  const d = new Date(t)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const load = async () => {
  if (!props.recordId) return
  loading.value = true
  record.value = null
  revisions.value = []
  try {
    const res = await getRecordRevisions(props.recordId)
    record.value = res.data.record
    revisions.value = res.data.revisions
  } finally {
    loading.value = false
  }
}

watch(() => props.recordId, (v) => { if (v) load() }, { immediate: true })
</script>
