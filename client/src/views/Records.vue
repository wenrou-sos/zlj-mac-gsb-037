<template>
  <div class="page-container">
    <div class="page-header">
      <div>
        <h2 class="page-title">📜 生产记录</h2>
        <p style="color: #6b7280; margin-top: 4px;">
          {{ isManager ? '查看所有生产进度上报历史' : '仅展示本人上报记录，可对有误记录提交纠错申请' }}
        </p>
      </div>
      <el-button type="primary" plain @click="loadData" :loading="loading">
        <el-icon><Refresh /></el-icon>
        <span style="margin-left: 4px;">刷新</span>
      </el-button>
    </div>

    <div class="stat-card" style="margin-bottom: 16px;">
      <div style="display: flex; gap: 16px; flex-wrap: wrap; align-items: center;">
        <el-input v-model="filter.order_no" placeholder="工单号" clearable style="width: 200px;" @clear="loadData" @keyup.enter="loadData" />
        <el-select v-if="isManager" v-model="filter.user_id" placeholder="上报人" clearable style="width: 160px;" @change="loadData">
          <el-option v-for="u in workers" :key="u.id" :label="u.real_name" :value="u.id" />
        </el-select>
        <el-select v-model="filter.correction_status" placeholder="纠错状态" clearable style="width: 170px;" @change="loadData">
          <el-option label="有待审批申请" value="pending" />
          <el-option label="已产生修订" value="approved" />
          <el-option label="从未申请纠错" value="none" />
        </el-select>
        <el-button type="primary" @click="loadData">查询</el-button>
      </div>
    </div>

    <div class="stat-card">
      <el-table :data="records" v-loading="loading" stripe :header-cell-style="{ background: '#f9fafb' }">
        <el-table-column type="index" label="#" width="50" align="center" />
        <el-table-column prop="order_no" label="工单号" width="150" />
        <el-table-column prop="line_name" label="产线" width="110" />
        <el-table-column label="产品" min-width="180">
          <template #default="{ row }">
            <div style="font-weight: 500;">{{ row.product_name }}</div>
            <div style="font-size: 12px; color: #6b7280;">{{ row.product_model }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="user_name" label="上报人" width="90" />
        <el-table-column prop="completed_qty" label="完成数" width="80" align="center" />
        <el-table-column prop="defect_qty" label="不良数" width="80" align="center">
          <template #default="{ row }">
            <span v-if="row.defect_qty > 0" style="color: #dc2626; font-weight: 600;">{{ row.defect_qty }}</span>
            <span v-else>0</span>
          </template>
        </el-table-column>
        <el-table-column prop="work_hours" label="工时(h)" width="90" align="center" />
        <el-table-column label="版本" width="120" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.current_version > 0 ? 'warning' : 'info'">
              v{{ row.current_version }}
            </el-tag>
            <el-tooltip v-if="row.last_revised_at" :content="'最近修订 ' + formatFullTime(row.last_revised_at)" placement="top">
              <el-icon style="margin-left: 4px; color: #b45309; vertical-align: middle;"><WarningFilled /></el-icon>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="纠错状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.has_pending_correction" type="warning" size="small">待审批</el-tag>
            <el-tag v-else-if="row.current_version > 0" type="success" size="small">已修订</el-tag>
            <span v-else style="color: #d1d5db; font-size: 12px;">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="defect_reason" label="不良原因" min-width="130">
          <template #default="{ row }">
            <el-tag v-if="row.defect_reason" type="warning" effect="light">{{ row.defect_reason }}</el-tag>
            <span v-else style="color: #d1d5db;">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="110">
          <template #default="{ row }">
            <span v-if="row.remark" style="color: #6b7280;">{{ row.remark }}</span>
            <span v-else style="color: #d1d5db;">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="上报时间" width="170">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right" align="center">
          <template #default="{ row }">
            <el-button v-if="!isManager" type="primary" size="small" link
              :disabled="row.has_pending_correction"
              @click="openApply(row)">
              {{ row.has_pending_correction ? '审批中' : (row.current_version > 0 ? '再次纠错' : '申请纠错') }}
            </el-button>
            <el-button type="primary" size="small" link @click="openTimeline(row)">修订时间线</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!loading && records.length === 0" style="text-align: center; padding: 60px; color: #9ca3af;">暂无记录</div>
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

    <CorrectionApplyDialog v-model="applyVisible" :record="applyRecord" @submitted="loadData" />
    <RevisionTimelineDialog v-model="timelineVisible" :record-id="timelineRecordId" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { Refresh, WarningFilled } from '@element-plus/icons-vue'
import { getRecords, getUsers } from '@/api/modules'
import CorrectionApplyDialog from '@/components/CorrectionApplyDialog.vue'
import RevisionTimelineDialog from '@/components/RevisionTimelineDialog.vue'

const user = JSON.parse(localStorage.getItem('user') || '{}')
const isManager = computed(() => Number(user.role) === 1)
const loading = ref(false)
const records = ref([])
const workers = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const filter = reactive({ order_no: '', user_id: '', correction_status: '' })

const applyVisible = ref(false)
const applyRecord = ref(null)
const timelineVisible = ref(false)
const timelineRecordId = ref(null)

const pad = (n) => String(n).padStart(2, '0')
const formatTime = (t) => {
  if (!t) return '-'
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const formatFullTime = (t) => {
  if (!t) return '-'
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const loadData = async () => {
  loading.value = true
  try {
    const params = { page: page.value, pageSize: pageSize.value }
    // 操作工：服务端强制只返回本人记录（不再依赖前端传 user_id）
    if (isManager.value && filter.user_id) params.user_id = filter.user_id
    if (filter.correction_status) params.correction_status = filter.correction_status
    const res = await getRecords(params)
    let data = res.data
    if (filter.order_no) {
      const kw = filter.order_no.trim().toLowerCase()
      data = data.filter(r => (r.order_no || '').toLowerCase().includes(kw))
    }
    records.value = data
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

const openApply = (row) => {
  applyRecord.value = row
  applyVisible.value = true
}

const openTimeline = (row) => {
  timelineRecordId.value = row.id
  timelineVisible.value = true
}

onMounted(loadData)
</script>
