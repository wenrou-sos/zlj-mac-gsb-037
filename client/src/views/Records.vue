<template>
  <div class="page-container">
    <div class="page-header">
      <div>
        <h2 class="page-title">📜 生产记录</h2>
        <p style="color: #6b7280; margin-top: 4px;">查看所有生产进度上报历史（显示当前生效值，修订记录可追溯）</p>
      </div>
      <el-button type="primary" plain @click="loadData" :loading="loading">
        <el-icon><Refresh /></el-icon>
        <span style="margin-left: 4px;">刷新</span>
      </el-button>
    </div>

    <div class="stat-card" style="margin-bottom: 16px;">
      <div style="display: flex; gap: 16px; flex-wrap: wrap;">
        <el-input v-model="filter.order_no" placeholder="工单号" clearable style="width: 200px;" @clear="loadData" @keyup.enter="loadData" />
        <el-select v-model="filter.user_id" placeholder="上报人" clearable style="width: 160px;" @change="loadData">
          <el-option v-for="u in workers" :key="u.id" :label="u.real_name" :value="u.id" />
        </el-select>
        <el-button type="primary" @click="loadData">查询</el-button>
      </div>
    </div>

    <div class="stat-card">
      <el-table :data="records" v-loading="loading" stripe :header-cell-style="{ background: '#f9fafb' }">
        <el-table-column type="index" label="#" width="60" align="center" />
        <el-table-column prop="order_no" label="工单号" width="150" />
        <el-table-column prop="line_name" label="产线" width="110" />
        <el-table-column label="产品" min-width="180">
          <template #default="{ row }">
            <div style="font-weight: 500;">{{ row.product_name }}</div>
            <div style="font-size: 12px; color: #6b7280;">{{ row.product_model }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="user_name" label="上报人" width="90" />
        <el-table-column label="完成数" width="90" align="center">
          <template #default="{ row }">
            <div>{{ row.effective_completed_qty }}</div>
            <div v-if="row.revision_no > 0 && row.effective_completed_qty !== row.completed_qty" class="old-value">原: {{ row.completed_qty }}</div>
          </template>
        </el-table-column>
        <el-table-column label="不良数" width="90" align="center">
          <template #default="{ row }">
            <div>
              <span v-if="row.effective_defect_qty > 0" style="color: #dc2626; font-weight: 600;">{{ row.effective_defect_qty }}</span>
              <span v-else>0</span>
            </div>
            <div v-if="row.revision_no > 0 && row.effective_defect_qty !== row.defect_qty" class="old-value">原: {{ row.defect_qty }}</div>
          </template>
        </el-table-column>
        <el-table-column label="工时(h)" width="90" align="center">
          <template #default="{ row }">
            <div>{{ row.effective_work_hours }}</div>
            <div v-if="row.revision_no > 0 && Number(row.effective_work_hours) !== Number(row.work_hours)" class="old-value">原: {{ row.work_hours }}</div>
          </template>
        </el-table-column>
        <el-table-column label="不良原因" min-width="130">
          <template #default="{ row }">
            <el-tag v-if="row.effective_defect_reason" type="warning" effect="light">{{ row.effective_defect_reason }}</el-tag>
            <span v-else style="color: #d1d5db;">-</span>
          </template>
        </el-table-column>
        <el-table-column label="修订状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.pending_correction_id" size="small" type="warning" effect="plain">纠错审批中</el-tag>
            <el-tag v-else-if="row.revision_no > 0" size="small" type="info" effect="plain">已修订 v{{ row.revision_no }}</el-tag>
            <span v-else style="color: #d1d5db;">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="110">
          <template #default="{ row }">
            <span v-if="row.remark" style="color: #6b7280;">{{ row.remark }}</span>
            <span v-else style="color: #d1d5db;">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="上报时间" width="165">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button size="small" link type="info" @click="openTimeline(row)">修订历史</el-button>
            <el-button
              v-if="isWorker"
              size="small"
              link
              type="primary"
              :disabled="!!row.pending_correction_id"
              @click="openCorrection(row)">申请纠错</el-button>
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

    <!-- 申请纠错对话框 -->
    <el-dialog v-model="correctionVisible" title="🛠 申请记录纠错" width="560px" destroy-on-close>
      <template v-if="correctionRecord">
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="纠错不会直接修改原记录，需主管批准后才生成新的生效版本"
          style="margin-bottom: 16px;" />
        <div style="margin-bottom: 16px; padding: 12px 16px; background: #f9fafb; border-radius: 8px; font-size: 13px;">
          <div><strong>{{ correctionRecord.order_no }}</strong> · 记录 #{{ correctionRecord.id }} · 上报于 {{ formatTime(correctionRecord.created_at) }}</div>
          <div style="margin-top: 6px; color: #6b7280;">
            当前生效值：完成 <strong style="color: #111827;">{{ correctionRecord.effective_completed_qty }}</strong>
            · 不良 <strong style="color: #111827;">{{ correctionRecord.effective_defect_qty }}</strong>
            · 工时 <strong style="color: #111827;">{{ correctionRecord.effective_work_hours }}h</strong>
            <span v-if="correctionRecord.revision_no > 0">（已修订 v{{ correctionRecord.revision_no }}）</span>
          </div>
        </div>
        <el-form :model="correctionForm" :rules="correctionRules" ref="correctionFormRef" label-width="100px">
          <el-form-item label="修正完成数" prop="new_completed_qty">
            <el-input-number v-model="correctionForm.new_completed_qty" :min="0" :max="999999" style="width: 100%;" />
          </el-form-item>
          <el-form-item label="修正不良数" prop="new_defect_qty">
            <el-input-number v-model="correctionForm.new_defect_qty" :min="0" :max="999999" style="width: 100%;" />
          </el-form-item>
          <el-form-item label="修正工时" prop="new_work_hours">
            <el-input-number v-model="correctionForm.new_work_hours" :min="0" :max="24" :step="0.5" :precision="1" style="width: 100%;" />
          </el-form-item>
          <el-form-item label="不良原因">
            <el-input v-model="correctionForm.new_defect_reason" placeholder="修正后的不良原因（可选）" type="textarea" :rows="2" maxlength="500" />
          </el-form-item>
          <el-form-item label="纠错原因" prop="reason">
            <el-input v-model="correctionForm.reason" placeholder="必填：说明为什么需要纠错" type="textarea" :rows="3" maxlength="500" show-word-limit />
          </el-form-item>
        </el-form>
      </template>
      <template #footer>
        <el-button @click="correctionVisible = false">取消</el-button>
        <el-button type="primary" @click="submitCorrection" :loading="submittingCorrection">提交申请</el-button>
      </template>
    </el-dialog>

    <!-- 修订时间线对话框 -->
    <el-dialog v-model="timelineVisible" :title="`记录 #${timelineRecordId} 修订时间线`" width="560px" destroy-on-close>
      <RevisionTimeline v-if="timelineVisible" :record-id="timelineRecordId" />
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { getRecords, getUsers, createCorrection } from '@/api/modules'
import RevisionTimeline from '@/components/RevisionTimeline.vue'

const user = JSON.parse(localStorage.getItem('user') || '{}')
const isWorker = user.role === 2
const loading = ref(false)
const records = ref([])
const workers = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const filter = reactive({ order_no: '', user_id: '' })

const correctionVisible = ref(false)
const correctionRecord = ref(null)
const submittingCorrection = ref(false)
const correctionFormRef = ref(null)
const correctionForm = reactive({
  new_completed_qty: 0, new_defect_qty: 0, new_work_hours: 0, new_defect_reason: '', reason: ''
})
const correctionRules = {
  reason: [{ required: true, message: '请填写纠错原因', trigger: 'blur' }],
  new_completed_qty: [{
    validator: (r, v, cb) => {
      if (v === 0 && correctionForm.new_defect_qty === 0) {
        cb(new Error('修正完成数与不良数不能同时为0'))
      } else {
        cb()
      }
    }, trigger: 'blur'
  }]
}

const timelineVisible = ref(false)
const timelineRecordId = ref(null)

const formatTime = (t) => {
  if (!t) return '-'
  const d = new Date(t)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const loadData = async () => {
  loading.value = true
  try {
    const params = { page: page.value, pageSize: pageSize.value }
    if (user.role === 2) params.user_id = user.id
    if (filter.user_id) params.user_id = filter.user_id
    const res = await getRecords(params)
    records.value = res.data
    total.value = res.total
    if (workers.value.length === 0) {
      try {
        const u = await getUsers({ role: 2 })
        workers.value = u.data
      } catch {}
    }
  } finally {
    loading.value = false
  }
}

const openCorrection = (row) => {
  correctionRecord.value = row
  Object.assign(correctionForm, {
    new_completed_qty: row.effective_completed_qty,
    new_defect_qty: row.effective_defect_qty,
    new_work_hours: Number(row.effective_work_hours),
    new_defect_reason: row.effective_defect_reason || '',
    reason: ''
  })
  correctionVisible.value = true
}

const submitCorrection = async () => {
  await correctionFormRef.value.validate()
  submittingCorrection.value = true
  try {
    const res = await createCorrection({
      record_id: correctionRecord.value.id,
      new_completed_qty: correctionForm.new_completed_qty,
      new_defect_qty: correctionForm.new_defect_qty,
      new_work_hours: correctionForm.new_work_hours,
      new_defect_reason: correctionForm.new_defect_reason || '',
      reason: correctionForm.reason
    })
    ElMessage.success(res.message || '纠错申请已提交')
    correctionVisible.value = false
    loadData()
  } finally {
    submittingCorrection.value = false
  }
}

const openTimeline = (row) => {
  timelineRecordId.value = row.id
  timelineVisible.value = true
}

onMounted(loadData)
</script>

<style scoped>
.old-value {
  font-size: 12px;
  color: #9ca3af;
  text-decoration: line-through;
}
</style>
