export interface PatchTask {
  patchTaskId: string;
  issueId: string;
  description: string;
  suggestedApproach: string;
  contextFiles: string[];
  testRequirements: string;
  status: 'pending' | 'generating' | 'review_pending' | 'approved' | 'rejected' | 'merged';
  createdAt: string;
}

export interface PRRecord {
  patchTaskId: string;
  issueId: string;
  prUrl: string;
  branchName: string;
  status: 'open' | 'approved' | 'rejected' | 'merged';
  claudeCodeReview?: string;
  approvedByUserId?: number;
  createdAt: string;
}
