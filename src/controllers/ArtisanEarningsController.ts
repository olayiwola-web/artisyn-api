import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import type { EarningStatus, EarningType } from '@prisma/client';

import { EarningsSummaryResource } from 'src/resources/EarningsSummaryResource';
import { EarningsTransactionCollection } from 'src/resources/EarningsTransactionCollection';
import type { EarningsTransactionRow } from 'src/resources/EarningsTransactionResource';

const prisma = new PrismaClient();

export type EarningsPeriod = '7d' | '30d' | '90d' | 'all';

const PERIOD_DAYS: Record<Excluded<EarningsPeriod, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const EARNING_STATUSES: readonly EarningStatus[] = [
  'PENDING',
  'AVAILABLE',
  'PAID',
  'FAILED',
  'REFUNDED',
];

function parsePeriod(value: unknown): EarningsPeriod {
  if (value === '7d' || value === '30d' || value === '90d' || value === 'all') {
    return value;
  }
  return '30d';
}

function parsePositiveInt(value: unknown, fallback: number, max?: number): number {
  const num = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(num) || num < 1) {
    return fallback;
  }
  const integer = Math.floor(num);
  if (max !== undefined && integer > max) {
    return max;
  }
  return integer;
}

function periodStart(period: EarningsPeriod): Date | null {
  if (period === 'all') {
    return null;
  }
  const days = PERIOD_DAYS[period];
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
}

/** The table stores `EarningType`; the API speaks in tip/job terms. */
function toEarningType(value: unknown): EarningType | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.toUpperCase();
  if (normalized === 'TIP') {
    return 'TIP';
  }
  if (normalized === 'JOB' || normalized === 'JOB_PAYOUT') {
    return 'JOB_PAYOUT';
  }
  return undefined;
}

function toEarningStatus(value: unknown): EarningStatus | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const upper = value.toUpperCase() as EarningStatus;
  return EARNING_STATUSES.includes(upper) ? upper : undefined;
}

function toTransactionRow(row: {
  id: string;
  type: EarningType;
  status: EarningStatus;
  amountMinor: bigint;
  currency: string;
  description: string | null;
  jobId: string | null;
  tipId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): EarningsTransactionRow {
  return {
    id: row.id,
    type: row.type === 'TIP' ? 'tip' : 'job',
    status: row.status,
    amountMinorUnits: row.amountMinor,
    currency: row.currency,
    description: row.description,
    jobId: row.jobId,
    tipId: row.tipId,
    // The earning row points at the job/tip it was raised for, not at the payer.
    counterpartyId: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export default class ArtisanEarningsController {
  public async summary(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ status: 'error', message: 'Authentication required', code: 401 });
        return;
      }

      const period = parsePeriod(req.query.period);
      const start = periodStart(period);

      const where = {
        artisanId: userId,
        ...(start ? { occurredAt: { gte: start } } : {}),
      };

      const grouped = await prisma.artisanEarning.groupBy({
        by: ['type'],
        where,
        _sum: { amountMinor: true },
        _count: { _all: true },
      });

      const totalMinorUnits = grouped.reduce(
        (acc, group) => acc + (group._sum.amountMinor ?? 0n),
        0n,
      );
      const totalCount = grouped.reduce((acc, group) => acc + group._count._all, 0);

      const tips = grouped.find((group) => group.type === 'TIP');
      const jobs = grouped.find((group) => group.type === 'JOB_PAYOUT');

      const currencyRow = await prisma.artisanEarning.findFirst({
        where,
        select: { currency: true },
        orderBy: { occurredAt: 'desc' },
      });

      const summary = {
        period,
        currency: currencyRow?.currency ?? 'USD',
        totalMinorUnits: totalMinorUnits.toString(),
        totalCount,
        tipsMinorUnits: (tips?._sum.amountMinor ?? 0n).toString(),
        tipsCount: tips?._count._all ?? 0,
        jobsMinorUnits: (jobs?._sum.amountMinor ?? 0n).toString(),
        jobsCount: jobs?._count._all ?? 0,
      };

      return res.status(200).json({
        data: EarningsSummaryResource.make(summary),
        status: 'success',
        message: 'OK',
        code: 200,
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        message: 'Failed to load earnings summary',
        code: 500,
      });
    }
  }

  public async transactions(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ status: 'error', message: 'Authentication required', code: 401 });
        return;
      }

      const period = parsePeriod(req.query.period);
      const start = periodStart(period);
      const page = parsePositiveInt(req.query.page, 1);
      const pageSize = parsePositiveInt(req.query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

      const type = toEarningType(req.query.type);
      const status = toEarningStatus(req.query.status);

      const where = {
        artisanId: userId,
        ...(start ? { occurredAt: { gte: start } } : {}),
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
      };

      const skip = (page - 1) * pageSize;

      const [total, rows] = await prisma.$transaction([
        prisma.artisanEarning.count({ where }),
        prisma.artisanEarning.findMany({
          where,
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          skip,
          take: pageSize,
        }),
      ]);

      const collection = EarningsTransactionCollection.make(rows.map(toTransactionRow), {
        page,
        pageSize,
        total,
        period,
      });

      return res.status(200).json({
        data: collection,
        status: 'success',
        message: 'OK',
        code: 200,
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        message: 'Failed to load earnings transactions',
        code: 500,
      });
    }
  }
}
