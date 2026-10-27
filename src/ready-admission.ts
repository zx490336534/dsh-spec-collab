import type { ParticipantRole, ReadinessCheck, RequirementRecord, ReviewKind } from './protocol.ts'

export function hasCompletedCurrentReview(record: Pick<RequirementRecord, 'aiRuns' | 'currentCommit'>, kind: ReviewKind): boolean {
  // A failed retry does not erase an earlier completed review of this exact body.
  return record.aiRuns.some(run => run.commit === record.currentCommit && run.kind === kind && run.status === 'completed')
}

export function hasVersionConfirmation(record: Pick<RequirementRecord, 'confirmations' | 'currentCommit'>, role: ParticipantRole): boolean {
  return record.confirmations.some(item => item.commit === record.currentCommit && item.role === role && item.scope === 'version' && item.status === 'active')
}

/** Shared by workflow guidance and the authoritative Ready write. Checks must come from the current Git body. */
export function readyAdmission(record: RequirementRecord, checks: ReadinessCheck[]) {
  const activeRun = record.aiRuns.slice().reverse().find(run => run.commit === record.currentCommit && (run.status === 'queued' || run.status === 'running'))
  const engineeringReviewed = hasCompletedCurrentReview(record, 'engineering-precheck')
  const pendingPatches = record.patches.filter(item => item.baseCommit === record.currentCommit && item.status === 'pending')
  const failedChecks = checks.filter(check => !check.passed)
  const productConfirmed = hasVersionConfirmation(record, 'product')
  const engineeringConfirmed = hasVersionConfirmation(record, 'engineering')
  const error = record.stage !== 'joint-review' ? 'readiness gate is not satisfied'
    : !record.workspaceId?.trim() ? 'review workspace is required'
    : activeRun ? 'current version review is still running'
    : !engineeringReviewed ? 'engineering precheck is required for the current version'
    : pendingPatches.length > 0 ? 'current version has pending patches'
    : failedChecks.length > 0 ? 'readiness gate is not satisfied'
    : !productConfirmed || !engineeringConfirmed ? 'current version needs product and engineering confirmation'
    : undefined
  return { activeRun, engineeringReviewed, pendingPatches, failedChecks, productConfirmed, engineeringConfirmed, error }
}
