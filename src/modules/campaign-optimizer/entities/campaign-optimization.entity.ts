import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('campaign_optimizations')
@Index(['campaignId'])
export class CampaignOptimization {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  campaignId: string;

  @Column({ type: 'text' })
  insights: string;

  @Column({ type: 'text' })
  recommendations: string;

  @Column({ nullable: true, type: 'text' })
  abtestSuggestion?: string;

  @Column({ nullable: true, type: 'float' })
  completionRate?: number;

  @Column({ nullable: true, type: 'float' })
  unsubscribeRate?: number;

  @Column({ nullable: true, type: 'float' })
  replyRate?: number;

  @CreateDateColumn()
  generatedAt: Date;
}
