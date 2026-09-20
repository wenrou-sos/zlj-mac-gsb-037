<template>
  <div class="page-container">
    <div class="page-header">
      <div>
        <h2 class="page-title">{{ isManager ? '✅ 生产记录纠错审批' : '📝 我的纠错申请' }}</h2>
        <p style="color: #6b7280; margin-top: 4px;">
          {{ isManager
            ? '对比修正前后差异，批准后生成不可变修订并自动重算工单完成数、不良数、工时、状态与告警'
            : '仅可对本人上报的记录提交纠错，审批通过前原记录保持不变' }}
        </p>
      </div>
      <el-button type="primary" plain @click="loadData" :loading="loading">
        <el-icon><Refresh /></el-icon>
        <span style="margin-left: 4px;">刷新</span>
      </el-button>
    </div>

    <div class="stat-card" style="margin-bottom: 16px;">
      <div style="display: flex; gap: 12px; flex-wrap: wrap; align-items: center;">
        <el-radio-group v-model="filter.status" @change="reloadFirst">
          <el-radio-button label="">全部</el-radio-button>
          <el-radio-button label="0">⏳ 待审批</el-radio-button>
          <el-radio-button label="1">✔ 已批准</el-radio-button>
          <el-radio-button label="2">✖ 已驳回</el-radio-button>
        </el-radio-group>
        <el-input v-model="filter.order_no" placeholder="工单号" clearable style="width: 180px;"
          @clear="reloadFirst" @keyup.enter="reloadFirst" />
        <el-select v-if="isManager" v-model="filter.applicant_id" placeholder="申请人" clearable
          style="width: 150px;" @change="reloadFirst">
          <el-option v-for="u in workers" :key="u.id" :label="u.real_name" :value="u.id" />
        </el-select>
        <el-button type="primary" @click="reloadFirst">查询</el-button>
      </div>
    </div>

    <div class="stat-card">
      <el-table :data="rows" v-loading="loading" stripe :header-cell-style="{ background: '#f9fafb' }">
        <el-table-column label="工单号 / 产品" min-width="200">
          <template #default="{ row }">
            <div style="font-weight: 500;">{{ row.order_no }}</div>
            <div style="font-size: 12px; color: #6b7280;">
              {{ row.line_name }} · {{ row.product_name }}<span v-if="row.product_model"> ({{ row.product_model }})</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column v-if="isManager" prop="applicant_name" label="申请人" width="90" />
        <el-table-column label="修正差异" min-width="260">
          <template #default="{ row }">
            <div class="diff-line" v-for="d in changedFields(row)" :key="d.field">
              <span class="diff-label">{{ d.label }}</span>
              <span class="diff-old">{{ d.oldValue || '—' }}</span>
              <el-icon style="color:#9ca3af;"><Right /></el-icon>
              <span class="diff-new">{{ d.newValue || '—' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="纠错原因" min-width="180" show-overflow-tooltip />
        <el-table-column label="状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="statusTag(row.status)" effect="light">
              {{ statusText(row.status) }}
            </el-tag>
            <div v-if="row.status === 1" style="font-size:11px; color:#b45309; margin-top:2px;">
              已修订至 v{{ row.record_version }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="审批信息" min-width="160">
          <template #default="{ row }">
            <div v-if="row.status === 0" style="color:#9ca3af; font-size:12px;">
              申请于 {{ formatTime(row.created_at) }}
            </div>
            <template v-else>
              <div style="font-size:12px;">{{ row.reviewer_name }} · {{ formatTime(row.reviewed_at) }}</div>
              <div v-if="row.review_comment" style="font-size:12px; color:#6b7280;">
                意见：{{ row.review_comment }}
              </div>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right" align="center">
          <template #default="{ row }">
            <el-button v-if="isManager && row.status === 0" type="success" size="small"
              @click="openReview(row, true)">批准</el-button>
            <el-button v-if="isManager && row.status === 0" type="danger" size="small" plain
              @click="openReview(row, false)">驳回</el-button>
            <el-button v-if="!isManager && row.status === 2" type="primary" size="small" link
              @click="reapply(row)">重新申请</el-button>
            <el-button size="small" link @click="openTimeline(row)">修订时间线</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!loading && rows.length === 0" style="text-align: center; padding: 60px; color: #9ca3af;">
        暂无纠错申请
      </div>
    </div>

    <div style="margin-top: 16px; display: flex; justify-content: flex-end;">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :page-sizes="[10, 20, 50]"
        :total="total"
        layout="total, sizes, prev, pager, next, jumper"
        @size-change="reloadFirst"
        @current-change="loadData"
        background />
    </div>

    <!-- 审批对话框 -->
    <el-dialog v-model="reviewVisible" :title="approveMode ? '✔ 批准纠错并重新计算工单' : '✖ 驳回纠错申请'"
      width="640px" destroy-on-close>
      <div v-if="current" class="review-box">
        <el-alert
          :title="approveMode
            ? '批准后：原记录更新为修正值并生成不可变修订版本（v' + (current.record_version + 1) + '），工单按全部最新有效记录重新计算。'
            : '驳回后原记录与工单数据均不变化，操作工可修改后重新提交申请。'"
          :type="approveMode ? 'success' : 'warning'"
          :closable="false" show-icon style="margin-bottom: 16px;" />

        <div style="margin-bottom: 8px; font-size: 13px; color: #6b7280;">
          {{ current.order_no }} · {{ current.applicant_name }} 申请于 {{ formatTime(current.created_at) }}
        </div>

        <el-table :data="diffRows" border size="small" :header-cell-style="{ background: '#f9fafb' }">
          <el-table-column prop="label" label="字段" width="110" />
          <el-table-column label="原值">
            <template #default="{ row }">
              <span :class="{ 'cell-changed': row.changed }">{{ row.oldValue || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column width="50" align="center">
            <template #default><el-icon><Right /></el-icon></template>
          </el-table-column>
          <el-table-column label="修正值">
            <template #default="{ row }">
              <span :class="{ 'cell-changed': row.changed }">{{ row.newValue || '—' }}</span>
            </template>
          </el-table-column>
        </el-table>

        <div style="margin-top: 12px; font-size: 13px;">
          <strong>纠错原因：</strong>{{ current.reason }}
        </div>

        <el-form style="margin-top: 16px;">
          <el-form-item label="审批意见" :required="!approveMode">
            <el-input v-model="reviewComment" type="textarea" :rows="3" maxlength="500" show-word-limit
              :placeholder="approveMode ? '可填写批准说明（选填）' : '请填写驳回原因（必填）'" />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="reviewVisible = false">取消</el-button>
        <el-button :type="approveMode ? 'success' : 'danger'" :loading="submitting" @click="submitReview">
          确认{{ approveMode ? '批准' : '驳回' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 申请 / 重新申请对话框 -->
    <CorrectionApplyDialog v-model="applyVisible" :record="applyRecord" @submitted="onApplied" />

    <!-- 修订时间线 -->
    <RevisionTimelineDialog v-model="timelineVisible" :record-id="timelineRecordId" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElNotification } from 'element-plus'
import { Refresh, Right } from '@element-plus/icons-vue'
import { getCorrections, approveCorrection, rejectCorrection, getRecordDetail, getUsers } from '@/api/modules'
import CorrectionApplyDialog from '@/components/CorrectionApplyDialog.vue'
import RevisionTimelineDialog from '@/components/RevisionTimelineDialog.vue'

const user = JSON.parse(localStorage.getItem('user') || '{}')
const isManager = computed(() => Number(user.role) === 1)

const loading = ref(false)
const submitting = ref(false)
const rows = ref([])
const workers = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const filter = reactive({ status: '0', order_no: '', applicant_id: '' })

const reviewVisible = ref(false)
const approveMode = ref(true)
const current = ref(null)
const reviewComment = ref('')

const applyVisible = ref(false)
const applyRecord = ref(null)
const timelineVisible = ref(false)
const timelineRecordId = ref(null)

const statusText = (s) => ['待审批', '已批准', '已驳回'][s] || '未知'
const statusTag = (s) => (['warning', 'success', 'danger'][s] || 'info')
const formatTime = (t) => {
  if (!t) return '-'
  const d = new Date(t)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const changedFields = (row) => {
  const defs = [
    { field: 'completed_qty', label: '完成数' },
    { field: 'defect_qty', label: '不良数' },
    { field: 'work_hours', label: '工时' },
    { field: 'defect_reason', label: '不良原因' },
    { field: 'remark', label: '备注' }
  ]
  return defs.map(d => {
    const oldValue = row[`original_${d.field}`]
    const newValue = row[`corrected_${d.field}`]
    return {
      field: d.field,
      label: d.label,
      oldValue: oldValue === null ? '' : oldValue,
      newValue: newValue === null ? '' : newValue,
      changed: String(oldValue ?? '') !== String(newValue ?? '')
    }
  }).filter(d => d.changed)
}

const diffRows = computed(() => {
  if (!current.value) return []
  const defs = [
    { field: 'completed_qty', label: '完成数' },
    { field: 'defect_qty', label: '不良数' },
    { field: 'work_hours', label: '工时(h)' },
    { field: 'defect_reason', label: '不良原因' },
    { field: 'remark', label: '备注' }
  ]
  return defs.map(d => {
    const oldValue = current.value[`original_${d.field}`]
    const newValue = current.value[`corrected_${d.field}`]
    return {
      label: d.label,
      oldValue: oldValue === null ? '' : oldValue,
      newValue: newValue === null ? '' : newValue,
      changed: String(oldValue ?? '') !== String(newValue ?? '')
    }
  })
})

const reloadFirst = () => { page.value = 1; loadData() }

const loadData = async () => {
  loading.value = true
  try {
    const params = { page: page.value, pageSize: pageSize.value }
    if (filter.status !== '') params.status = filter.status
    if (filter.applicant_id) params.applicant_id = filter.applicant_id
    const res = await getCorrections(params)
    let data = res.data
    if (filter.order_no) {
      const kw = filter.order_no.trim().toLowerCase()
      data = data.filter(c => (c.order_no || '').toLowerCase().includes(kw))
    }
    rows.value = data
    total.value = res.total
    if (isManager.value && workers.value.length === 0) {
      try {
        const u = await getUsers({ role: 2 })
        workers.value = u.data
      } catch {}
    }
  } finally {
    loading.value = false
  }
}

const openReview = (row, approve) => {
  current.value = row
  approveMode.value = approve
  reviewComment.value = ''
  reviewVisible.value = true
}

const submitReview = async () => {
  if (!approveMode.value && !reviewComment.value.trim()) {
    ElMessage.warning('驳回时必须填写审批意见')
    return
  }
  submitting.value = true
  try {
    const fn = approveMode.value ? approveCorrection : rejectCorrection
    const res = await fn(current.value.id, reviewComment.value.trim())
    reviewVisible.value = false
    if (approveMode.value && res.data?.work_order?.defect_alert) {
      ElNotification({
        title: '⚠ 重算后不良率仍超阈值',
        message: res.message,
        type: 'warning',
        duration: 6000
      })
    } else {
      ElMessage.success(res.message)
    }
    loadData()
  } finally {
    submitting.value = false
  }
}

// 操作工“重新申请”：拉取该记录当前生效值作为表单初值（服务端强制仅可查本人记录）
const reapply = async (row) => {
  try {
    const res = await getRecordDetail(row.record_id)
    applyRecord.value = res.data
    applyVisible.value = true
  } catch {}
}

const onApplied = () => { reloadFirst() }

const openTimeline = (row) => {
  timelineRecordId.value = row.record_id
  timelineVisible.value = true
}

onMounted(loadData)
</script>

<style scoped>
.diff-line { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 1.9; }
.diff-label { color: #6b7280; width: 58px; flex-shrink: 0; }
.diff-old { color: #6b7280; text-decoration: line-through; }
.diff-new { color: #b45309; font-weight: 600; }
.cell-changed { color: #b45309; font-weight: 600; }
</style>
