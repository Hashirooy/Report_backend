import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * How far behind a heartbeat has to fall before its job is considered orphaned.
 * A multiple of the task timeout, so a task that is merely slow is never
 * mistaken for a dead one.
 */
const STALE_TIMEOUT_MULTIPLIER = 2;

/**
 * Finds jobs whose worker died mid-run.
 *
 * A job in `running` with nobody touching its heartbeat is stranded: the queue
 * message is long consumed and nothing will ever finish it. They are failed
 * rather than requeued on purpose — restarting an agent job spends money, and
 * whether that is worth it is an operator's call, not a boot-time default. The
 * tasks that did finish keep their output, so a re-run starts from what is
 * already there.
 */
@Injectable()
export class RepsRecoveryService {
  private readonly logger = new Logger(RepsRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async recoverStaleJobs(): Promise<number> {
    const timeoutMs = this.config.getOrThrow<number>('reps.taskTimeoutMs');
    const cutoff = new Date(Date.now() - timeoutMs * STALE_TIMEOUT_MULTIPLIER);

    const stale = await this.prisma.repsJob.findMany({
      where: {
        status: 'running',
        OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null }],
      },
      select: { id: true, heartbeatAt: true },
    });

    for (const job of stale) {
      const error =
        'the worker stopped while this job was running' +
        (job.heartbeatAt ? ` (last sign of life ${job.heartbeatAt.toISOString()})` : '');

      await this.prisma.$transaction([
        this.prisma.repsTask.updateMany({
          where: { jobId: job.id, status: 'running' },
          data: { status: 'failed', error, finishedAt: new Date() },
        }),
        this.prisma.repsJob.update({
          where: { id: job.id },
          data: { status: 'failed', error, finishedAt: new Date() },
        }),
        this.prisma.repsEvent.create({
          data: { jobId: job.id, level: 'error', message: error },
        }),
      ]);

      this.logger.warn(`job ${job.id} recovered as failed: ${error}`);
    }

    return stale.length;
  }
}
