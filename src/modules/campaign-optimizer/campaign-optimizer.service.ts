import { Injectable, Logger, OnModuleInit, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Campaign } from './entities/campaign.entity';
import { CampaignOptimization } from './entities/campaign-optimization.entity';
import { LlmService } from '../llm/llm.service';

export interface Insight {
  issue: string;
  metric: string;
  severity: 'high' | 'medium' | 'low';
}

export interface Recommendation {
  action: string;
  rationale: string;
  expectedImpact: string;
  priority: number;
}

export interface ABTestSuggestion {
  stepIndex: number;
  variantA: string;
  variantB: string;
  hypothesis: string;
}

export interface OptimizationResult {
  insights: Insight[];
  recommendations: Recommendation[];
  bestPerformingStep: number;
  worstPerformingStep: number;
  abtestSuggestion: ABTestSuggestion | null;
}

const ENROLLMENT_TRIGGER_DELTA = 50;
const CHECK_INTERVAL_MS = 3_600_000; // 1 hour

@Injectable()
export class CampaignOptimizerService implements OnModuleInit {
  private readonly logger = new Logger(CampaignOptimizerService.name);

  constructor(
    @InjectRepository(Campaign, 'data') private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(CampaignOptimization, 'data') private readonly optRepo: Repository<CampaignOptimization>,
    private readonly llm: LlmService,
  ) {}

  onModuleInit(): void {
    setInterval(() => this.checkAndTriggerOptimizations(), CHECK_INTERVAL_MS);
  }

  private async checkAndTriggerOptimizations(): Promise<void> {
    try {
      const campaigns = await this.campaignRepo.find();
      for (const c of campaigns) {
        const delta = c.enrollmentCount - c.lastOptimizedEnrollmentCount;
        if (delta >= ENROLLMENT_TRIGGER_DELTA) {
          this.logger.log(`Auto-optimizing campaign ${c.id} (delta: ${delta} enrollments)`);
          await this.analyzeAndOptimize(c.id).catch(e =>
            this.logger.warn(`Auto-optimize failed for ${c.id}: ${(e as Error).message}`)
          );
        }
      }
    } catch (e) {
      this.logger.error('Auto-optimize check failed', e);
    }
  }

  async analyzeAndOptimize(campaignId: string): Promise<CampaignOptimization> {
    const campaign = await this.campaignRepo.findOne({ where: { id: campaignId } });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const stepFunnel: number[] = campaign.stepFunnel ? JSON.parse(campaign.stepFunnel) : [];
    const steps: { content: string; completionRate: number }[] = campaign.steps ? JSON.parse(campaign.steps) : [];

    let maxDropoffIndex = 0;
    if (stepFunnel.length > 1) {
      let maxDrop = 0;
      for (let i = 1; i < stepFunnel.length; i++) {
        const drop = stepFunnel[i - 1] - stepFunnel[i];
        if (drop > maxDrop) { maxDrop = drop; maxDropoffIndex = i; }
      }
    }

    const stepSummary = stepFunnel.map((pct, i) => {
      const label = steps[i]?.content?.slice(0, 50) ?? `Step ${i + 1}`;
      return `Step ${i + 1} (${label}...): ${pct}%`;
    }).join(', ') || 'No step data';

    const prompt = `You are a WhatsApp marketing expert. Analyze this drip campaign and provide optimization recommendations.

Campaign: ${campaign.name}
Stats:
- ${campaign.enrollmentCount} enrollments, ${campaign.completionRate ?? 0}% completion, ${campaign.unsubscribeRate ?? 0}% unsubscribe rate, ${campaign.replyRate ?? 0}% reply rate
- Step funnel: ${stepSummary}
- Highest drop-off: Step ${maxDropoffIndex + 1}

Respond as JSON:
{
  "insights": [{ "issue": string, "metric": string, "severity": "high"|"medium"|"low" }],
  "recommendations": [{ "action": string, "rationale": string, "expectedImpact": string, "priority": 1-5 }],
  "bestPerformingStep": number,
  "worstPerformingStep": number,
  "abtestSuggestion": { "stepIndex": number, "variantA": string, "variantB": string, "hypothesis": string } | null
}`;

    const response = await this.llm.complete([{ role: 'user', content: prompt }], { jsonMode: true, maxTokens: 1500 });

    let parsed: OptimizationResult;
    try {
      parsed = JSON.parse(response.content) as OptimizationResult;
    } catch {
      parsed = { insights: [], recommendations: [], bestPerformingStep: 0, worstPerformingStep: maxDropoffIndex, abtestSuggestion: null };
    }

    const opt = this.optRepo.create({
      campaignId,
      insights: JSON.stringify(parsed.insights ?? []),
      recommendations: JSON.stringify(parsed.recommendations ?? []),
      abtestSuggestion: parsed.abtestSuggestion ? JSON.stringify(parsed.abtestSuggestion) : undefined,
      completionRate: campaign.completionRate,
      unsubscribeRate: campaign.unsubscribeRate,
      replyRate: campaign.replyRate,
    });
    const saved = await this.optRepo.save(opt);

    await this.campaignRepo.save({ ...campaign, lastOptimizedEnrollmentCount: campaign.enrollmentCount });
    return saved;
  }

  async suggestABTest(campaignId: string): Promise<ABTestSuggestion | null> {
    const latest = await this.optRepo.findOne({ where: { campaignId }, order: { generatedAt: 'DESC' } });
    if (!latest?.abtestSuggestion) return null;
    return JSON.parse(latest.abtestSuggestion) as ABTestSuggestion;
  }

  async getLatestOptimization(campaignId: string): Promise<CampaignOptimization | null> {
    return this.optRepo.findOne({ where: { campaignId }, order: { generatedAt: 'DESC' } });
  }

  // Campaign CRUD
  async createCampaign(sessionId: string, name: string): Promise<Campaign> {
    return this.campaignRepo.save(this.campaignRepo.create({ sessionId, name }));
  }

  async listCampaigns(sessionId: string): Promise<Campaign[]> {
    return this.campaignRepo.find({ where: { sessionId }, order: { createdAt: 'DESC' } });
  }

  async updateCampaignStats(id: string, sessionId: string, stats: Partial<Campaign>): Promise<Campaign> {
    const c = await this.campaignRepo.findOne({ where: { id, sessionId } });
    if (!c) throw new NotFoundException(`Campaign ${id} not found`);
    return this.campaignRepo.save({ ...c, ...stats });
  }

  performanceScore(c: Campaign): number {
    const completion = c.completionRate ?? 0;
    const unsub = c.unsubscribeRate ?? 0;
    const reply = c.replyRate ?? 0;
    // Weighted composite: completion 50%, inverse-unsub 30%, reply 20%
    return Math.round(completion * 0.5 + Math.max(0, 100 - unsub * 5) * 0.3 + reply * 2);
  }

  async applyRecommendation(campaignId: string, index: number): Promise<Recommendation | null> {
    const latest = await this.getLatestOptimization(campaignId);
    if (!latest) return null;
    const recs = JSON.parse(latest.recommendations) as Recommendation[];
    return recs[index] ?? null;
  }
}
