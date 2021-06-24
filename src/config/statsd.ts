import {StatsD, StatsCb, Tags} from 'hot-shots';
import bunyan from 'bunyan';
import {Request, Response, NextFunction} from 'express';

const isTest = process.env.NODE_ENV === 'test'

export const globalTags = {
  environment: isTest ? 'test' : process.env.MICROS_ENV,
  environment_type: isTest ? 'testenv' : process.env.MICROS_ENVTYPE,
  deployment_id: process.env.MICROS_DEPLOYMENT_ID || '1',
  region: process.env.MICROS_AWS_REGION || 'localhost'
};

const logger = bunyan.createLogger({ name: 'statsd' });

const statsd = new StatsD({
  prefix: 'github-for-jira.',
  host: 'platform-statsd',
  port: 8125,
  globalTags,
  errorHandler: (err) => logger.warn({ err }, 'error writing metrics'),
  mock: isTest,
});

/**
 * High-resolution timer
 *
 * @returns {function(): number} A function to call to get the duration since this function was created
 */
 function hrtimer() {
  const start = process.hrtime();

  return () => {
    const durationComponents = process.hrtime(start);
    const seconds = durationComponents[0];
    const nanoseconds = durationComponents[1];
    return seconds * 1000 + nanoseconds / 1e6;
  };
}

interface StatsdRequest extends Request {
  statsdKey: string;
  statsdTags: string[];
}

export const expressStatsdMetrics = (path: string) =>  {
  return function (req: StatsdRequest, res: Response, next: NextFunction) {
    const expressStatsdLogger = bunyan.createLogger({ name: 'elapsedTimeInMs' });
    const method = req.method || 'unknown_method';

    req.statsdKey = ['http', method.toLowerCase(), path].join('.');
    expressStatsdLogger.info("before finishing")
    res.on("finish", () => {
      const elapsedTimeInMs = hrtimer()
      expressStatsdLogger.info("%s : %fms", req.path, elapsedTimeInMs);

      req.statsdTags = [`elapsedTimeInMs: ${elapsedTimeInMs}`]
    });

    expressStatsdLogger.info("after finishing")
    next();
  };
}

/**
 * Async Function Timer using Distributions
 */
export function asyncDistTimer(
  func: (...args: never[]) => Promise<unknown>,
  stat: string | string[],
  sampleRate?: number,
  tags?: Tags,
  callback?: StatsCb,
) {
  return (...args: never[]): Promise<unknown> => {
    const end = hrtimer();
    const p = func(...args);
    const recordStat = () =>
      statsd.distribution(stat, end(), sampleRate, tags, callback);
    p.then(recordStat, recordStat);
    return p;
  };
}

export default statsd;
