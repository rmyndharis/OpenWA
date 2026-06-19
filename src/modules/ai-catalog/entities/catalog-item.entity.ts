import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('ai_catalog_items')
@Index(['sessionId'])
export class CatalogItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  sessionId: string;

  @Column()
  sku: string;

  @Column()
  name: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'float', nullable: true })
  price?: number;

  @Column({ nullable: true })
  currency?: string;

  @Column({ nullable: true })
  category?: string;

  @Column({ nullable: true })
  stock?: string;

  @Column({ type: 'text', nullable: true })
  attributes?: string;

  @Column({ type: 'text', nullable: true })
  embeddingJson?: string | null;

  @Column({ default: true })
  available: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
