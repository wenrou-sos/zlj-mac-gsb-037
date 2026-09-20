<template>
  <div class="page-container">
    <div class="page-header">
      <div>
        <h2 class="page-title">{{ isSupervisor ? '✅ 纠错审批' : '📝 我的纠错申请' }}</h2>
        <p style="color: #6b7280; margin-top: 4px;">
          {{ isSupervisor ? '审批操作工提交的生产记录纠错申请，批准后按最新有效记录重算工单' : '查看本人提交的纠错申请及审批进度' }}
        </p>
      </div>
      <el-button type="primary" plain @click="loadData" :loading="loading">
        <el-icon><Refresh /></el-icon>
        <span style="margin-left: 4px;">刷新</span>
      </el-button>
    </div>

    <div class="stat-card" style="margin-bottom: 16px;">
      <div style="display: flex; gap: 16px; flex-wrap: wrap; align-items: center;">
        <el-radio-group v-model="filter.status" @change="handleFilterChange">
          <el-radio-button value="">全部</el-radio-button>
          <el-radio-button value="0">待审批</el-radio-button>
          <el-radio-button value="1">已批准</el-radio-button>
          <el-radio-button value="2">已驳回</el-radio-button>
        </el-radio-group>
        <el-select v-if="isSupervisor" v-model="filter.applicant_id" placeholder="申请人" clearable style="width: 160px;" @change="handleFilterChange">
          <el-option v-for="u in workers" :key="u.id" :label="u.real_name" :value="u.id" />
        </el-select>
      </div>
    </div>

    <div class="stat-card">
      <el-table :data="list" v-loading="loading" stripe :header-cell-style="{ background: '#f9fafb' }">
        <el-table-column prop="request_no" label="申请单号" width="170" />
        <el-table-column prop="order_no" label="工单号" width="150" />
        <el-table-column prop="record_id" label="记录ID" width="80" align="center" />
        <el-table-column prop="applicant_name" label="申请人" width="90" />
        <el-table-column label="修正差异" min-width="220">
          <template #default="{ row }">
            <span v-for="(d, i) in diffParts(row)" :key="i" style="margin-right: 8px; white-space: nowrap;">
              <span style="color: #6b7280;">{{ d.label }}</span>
              <span style="color: #9ca3af;"> {{ d.oldV }} </span>→
              <strong style="color: #1e40af;"> {{ d.newV }}</strong>
            </span>
            <span v-if="diffParts(row).length === 0" style="color: #d1d5db;">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="纠错原因" min-width="140" show-overflow-tooltip />
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" effect="light">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="审批信息" width="170">
          <template #default="{ row }">
            <div v-if="row.status !== 0" style="font-size: 12px;">
              <div>{{ row.reviewer_name || '-' }}</div>
              <div style="color: #9ca3af;">{{ formatTime(row.reviewed_at) }}</div>
            </div>
            <span v-else style="color: #d1d5db;">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="申请时间" width="165">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="openDetail(row)">
              {{ isSupervisor && row.status === 0 ? '审批' : '查看' }}
            </el-button>
            <el-button size="small" link type="info" @click="openTimeline(row)">修订时间线</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!loading && list.length === 0" style="text-align: center; padding: 60px; color: #9ca3af;">暂无纠错申请</div>
    </div>

    <div style="margin-top: 16px; display: flex; justify-content: flex-end;">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :page-sizes="[10, 20, 50]"
        :total="total"
        layout="total, sizes, prev, pager, next, jumper"
        @size-change="loadData"
        @current-change="loadData"
        background />
    </div>

    <!-- 申请详情 / 审批对话框 -->
    <el-dialog v-model="detailVisible" :title="`纠错申请 ${detail?.request_no || ''}`" width="640px" destroy-on-close>
      <template v-if="detail">
        <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 16px;">
          <el-tag :type="statusTagType(detail.status)" effect="dark">{{ statusText(detail.status) }}</el-tag>
          <span style="color: #6b7280; font-size: 13px;">
            工单 {{ detail.order_no }} · 记录 #{{ detail.record_id }} · 申请人 {{ detail.applicant_name }} · {{ formatTime(detail.created_at) }}
          </span>
        </div>

        <el-table :data="diffRows" border size="small" :row-class-name="diffRowClass">
          <el-table-column prop="label" label="字段" width="110" />
          <el-table-column label="当前生效值" width="180">
            <template #default="{ row }"><span :class="{ 'diff-old': row.changed }">{{ row.oldV }}</span></template>
          </el-table-column>
          <el-table-column label="修正值" min-width="180">
            <template #default="{ row }"><strong :class="{ 'diff-new': row.changed }">{{ row.newV }}</strong></template>
          </el-table-column>
        </el-table>

        <div style="margin-top: 14px; padding: 12px; background: #f9fafb; border-radius: 8px; font-size: 13px;">
          <div><span style="color: #6b7280;">纠错原因：</span>{{ detail.reason }}</div>
          <div v-if="detail.status !== 0" style="margin-top: 8px;">
            <span style="color: #6b7280;">审批意见：</span>{{ detail.review_comment || '-' }}
            <span style="color: #9ca3af; margin-left: 8px;">{{ detail.reviewer_name }} · {{ formatTime(detail.reviewed_at) }}</span>
          </div>
        </div>

        <template v-if="isSupervisor && detail.status === 0">
          <el-input
            v-model="reviewComment"
            type="textarea"
            :rows="3"
            placeholder="审批意见（驳回时必填）"
            style="margin-top: 14px;" />
        </template>
      </template>
      <template #footer>
        <template v-if="isSupervisor && detail && detail.status === 0">
          <el-button @click="detailVisible = false">取消</el-button>
          <el-button type="danger" plain @click="handleReject" :loading="reviewing">驳回</el-button>
          <el-button type="success" @click="handleApprove" :loading="reviewing">批准并重算</el-button>
        </template>
        <el-button v-else @click="detailVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 修订时间线对话框 -->
    <el-dialog v-model="timelineVisible" :title="`记录 #${timelineRecordId} 修订时间线`" width="560px" destroy-on-close>
      <RevisionTimeline v-if="timelineVisible" :record-id="timelineRecordId" />
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox, ElNotification } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { getCorrections, approveCorrection, rejectCorrection, getUsers } from '@/api/modules'
import RevisionTimeline from '@/components/RevisionTimeline.vue'

const user = JSON.parse(localStorage.getItem('user') || '{}')
const isSupervisor = computed(() => user.role === 1)

const loading = ref(false)
const reviewing = ref(false)
const list = ref([])
const workers = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const filter = reactive({ status: '', applicant_id: '' })

const detailVisible = ref(false)
const detail = ref(null)
const reviewComment = ref('')
const timelineVisible = ref(false)
const timelineRecordId = ref(null)

const statusText = (s) => ['待审批', '已批准', '已驳回'][s] || '未知'
const statusTagType = (s) => ['warning', 'success', 'danger'][s] || 'info'

const formatTime = (t) => {
  if (!t) return '-'
  const d = new Date(t)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const fmtHours = (v) => Number(v)

const diffParts = (row) => {
  const parts = []
  if (row.old_completed_qty !== row.new_completed_qty) {
    parts.push({ label: '完成', oldV: row.old_completed_qty, newV: row.new_completed_qty })
  }
  if (row.old_defect_qty !== row.new_defect_qty) {
    parts.push({ label: '不良', oldV: row.old_defect_qty, newV: row.new_defect_qty })
  }
  if (Number(row.old_work_hours) !== Number(row.new_work_hours)) {
    parts.push({ label: '工时', oldV: fmtHours(row.old_work_hours), newV: fmtHours(row.new_work_hours) })
  }
  if ((row.old_defect_reason || '') !== (row.new_defect_reason || '')) {
    parts.push({ label: '不良原因', oldV: row.old_defect_reason || '-', newV: row.new_defect_reason || '-' })
  }
  return parts
}

const diffRows = computed(() => {
  if (!detail.value) return []
  const d = detail.value
  return [
    { label: '完成数', oldV: d.old_completed_qty, newV: d.new_completed_qty, changed: d.old_completed_qty !== d.new_completed_qty },
    { label: '不良数', oldV: d.old_defect_qty, newV: d.new_defect_qty, changed: d.old_defect_qty !== d.new_defect_qty },
    { label: '工时(h)', oldV: fmtHours(d.old_work_hours), newV: fmtHours(d.new_work_hours), changed: Number(d.old_work_hours) !== Number(d.new_work_hours) },
    { label: '不良原因', oldV: d.old_defect_reason || '-', newV: d.new_defect_reason || '-', changed: (d.old_defect_reason || '') !== (d.new_defect_reason || '') }
  ]
})

const diffRowClass = ({ row }) => (row.changed ? 'diff-row-changed' : '')

const loadData = async () => {
  loading.value = true
  try {
    const params = { page: page.value, pageSize: pageSize.value }
    if (filter.status !== '') params.status = filter.status
    if (isSupervisor.value && filter.applicant_id) params.applicant_id = filter.applicant_id
    const res = await getCorrections(params)
    list.value = res.data
    total.value = res.total
    if (isSupervisor.value && workers.value.length === 0) {
      try {
        const u = await getUsers({ role: 2 })
        workers.value = u.data
      } catch {}
    }
  } finally {
    loading.value = false
  }
}

const handleFilterChange = () => {
  page.value = 1
  loadData()
}

const openDetail = (row) => {
  detail.value = row
  reviewComment.value = ''
  detailVisible.value = true
}

const openTimeline = (row) => {
  timelineRecordId.value = row.record_id
  timelineVisible.value = true
}

const handleApprove = async () => {
  await ElMessageBox.confirm(
    '批准后将生成不可变修订版本，并按全部最新有效记录重算工单完成数/不良数/工时/状态/告警，确认批准？',
    '批准确认',
    { type: 'warning', confirmButtonText: '确认批准', cancelButtonText: '取消' }
  )
  reviewing.value = true
  try {
    const res = await approveCorrection(detail.value.id, { review_comment: reviewComment.value || '' })
    if (res.warning) {
      ElNotification({
        title: '⚠ 不良率告警',
        message: res.message,
        type: 'error',
        duration: 6000,
        showClose: true
      })
    } else {
      ElMessage.success(res.message || '已批准')
    }
    detailVisible.value = false
    loadData()
  } finally {
    reviewing.value = false
  }
}

const handleReject = async () => {
  if (!reviewComment.value.trim()) {
    ElMessage.warning('驳回时必须填写审批意见')
    return
  }
  reviewing.value = true
  try {
    const res = await rejectCorrection(detail.value.id, { review_comment: reviewComment.value })
    ElMessage.success(res.message || '已驳回')
    detailVisible.value = false
    loadData()
  } finally {
    reviewing.value = false
  }
}

onMounted(loadData)
</script>

<style scoped>
.diff-old {
  color: #9ca3af;
  text-decoration: line-through;
}
.diff-new {
  color: #1e40af;
}
:deep(.diff-row-changed) {
  background: #fffbeb;
}
</style>
