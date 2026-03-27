/**
 * GitHubClient — PR 생성, 브랜치 관리, 머지 직접 처리
 * n8n 없이 GitHub REST API 직접 호출
 */

import { logger } from '../utils/logger.js';

interface CreatePRResult {
  prUrl: string;
  prNumber: number;
  branchName: string;
}

export class GitHubClient {
  private token = process.env.GITHUB_TOKEN ?? '';
  private owner = process.env.GITHUB_OWNER ?? '';
  private repo  = process.env.GITHUB_REPO  ?? '';

  private get baseUrl() {
    return `https://api.github.com/repos/${this.owner}/${this.repo}`;
  }

  private get headers() {
    return {
      Authorization:        `Bearer ${this.token}`,
      'Content-Type':       'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  isConfigured(): boolean {
    return !!(this.token && this.owner && this.repo);
  }

  /**
   * 기본 브랜치의 최신 SHA 조회
   */
  async getDefaultBranchSha(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/git/ref/heads/main`, { headers: this.headers });
    if (!res.ok) throw new Error(`getDefaultBranchSha failed: ${res.status}`);
    const data = await res.json() as { object: { sha: string } };
    return data.object.sha;
  }

  /**
   * 새 브랜치 생성
   */
  async createBranch(branchName: string, fromSha: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/git/refs`, {
      method:  'POST',
      headers: this.headers,
      body:    JSON.stringify({ ref: `refs/heads/${branchName}`, sha: fromSha }),
    });
    if (!res.ok && res.status !== 422) { // 422 = already exists
      throw new Error(`createBranch failed: ${res.status}`);
    }
  }

  /**
   * 파일 커밋 (없으면 생성, 있으면 업데이트)
   */
  async commitFile(branch: string, filePath: string, content: string, message: string): Promise<void> {
    // 기존 파일 SHA 조회 (업데이트 시 필요)
    let sha: string | undefined;
    const existing = await fetch(`${this.baseUrl}/contents/${filePath}?ref=${branch}`, {
      headers: this.headers,
    });
    if (existing.ok) {
      const data = await existing.json() as { sha: string };
      sha = data.sha;
    }

    const res = await fetch(`${this.baseUrl}/contents/${filePath}`, {
      method:  'PUT',
      headers: this.headers,
      body:    JSON.stringify({
        message,
        content: Buffer.from(content).toString('base64'),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) throw new Error(`commitFile failed: ${res.status} ${await res.text()}`);
  }

  /**
   * Pull Request 생성
   */
  async createPR(params: {
    title:  string;
    body:   string;
    head:   string;
    base?:  string;
  }): Promise<CreatePRResult> {
    const res = await fetch(`${this.baseUrl}/pulls`, {
      method:  'POST',
      headers: this.headers,
      body:    JSON.stringify({
        title: params.title,
        body:  params.body,
        head:  params.head,
        base:  params.base ?? 'main',
      }),
    });
    if (!res.ok) throw new Error(`createPR failed: ${res.status} ${await res.text()}`);
    const data = await res.json() as { html_url: string; number: number; head: { ref: string } };
    return { prUrl: data.html_url, prNumber: data.number, branchName: data.head.ref };
  }

  /**
   * PR 머지 (squash)
   */
  async mergePR(prNumber: number, commitTitle: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/pulls/${prNumber}/merge`, {
      method:  'PUT',
      headers: this.headers,
      body:    JSON.stringify({ merge_method: 'squash', commit_title: commitTitle }),
    });
    if (!res.ok) throw new Error(`mergePR failed: ${res.status} ${await res.text()}`);
    logger.info({ prNumber }, 'PR merged');
  }

  /**
   * Codex 패치 → 브랜치 생성 → 파일 커밋 → PR 생성 원스톱
   */
  async submitPatch(params: {
    issueId:     string;
    fingerprint: string;
    patchFiles:  Array<{ path: string; content: string }>;
    prTitle:     string;
    prBody:      string;
  }): Promise<CreatePRResult> {
    if (!this.isConfigured()) {
      throw new Error('GitHub not configured (GITHUB_TOKEN/OWNER/REPO missing)');
    }

    const branchName = `fix/${params.fingerprint.slice(0, 8)}-${params.issueId.slice(0, 8)}`;
    const baseSha    = await this.getDefaultBranchSha();

    await this.createBranch(branchName, baseSha);

    for (const file of params.patchFiles) {
      await this.commitFile(
        branchName,
        file.path,
        file.content,
        `fix(${params.fingerprint.slice(0, 8)}): auto-patch`,
      );
    }

    const pr = await this.createPR({
      title: params.prTitle,
      body:  params.prBody,
      head:  branchName,
    });

    logger.info({ prUrl: pr.prUrl, branchName }, 'Patch PR created');
    return pr;
  }
}
