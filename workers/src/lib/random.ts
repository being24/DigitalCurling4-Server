/**
 * Box-Muller法による標準一様乱数から標準正規乱数への変換。
 * Workers環境にNode.js `crypto`モジュールは無いため、標準Web Crypto API
 * (`crypto.getRandomValues`)を一様乱数源として使う。
 */
function randomUniformOpenInterval(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // (0, 1)の開区間に写像する(Box-Muller法はu1=0でlog(0)=-Infinityになるため0を除外する必要がある)
  return (buf[0] + 1) / (0xffffffff + 2);
}

/**
 * 平均`mean`・標準偏差`std`の正規分布に従う乱数を1つ生成する。
 * Python版`numpy.random.normal(loc=mean, scale=std)`のTS版代替。
 */
export function randomNormal(mean: number, std: number): number {
  const u1 = randomUniformOpenInterval();
  const u2 = randomUniformOpenInterval();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + std * z0;
}

export interface PlayerDistortionParams {
  maxVelocity: number;
  shotStdDev: number;
  angleStdDev: number;
}

export interface ShotInfoInput {
  translationalVelocity: number;
  shotAngle: number;
  angularVelocity: number;
}

export interface DistortedShotResult {
  translationalVelocity: number;
  shotAngle: number;
  angularVelocity: number;
  /** クランプ・符号反転後の実測値(post-distortion時点のshot_info.angular_velocity相当) */
  actualAngularVelocity: number;
}

/**
 * 投球パラメータにガウス分布ノイズを加える。
 * `src/routers/match.py::receive_shot_info`内の摂動ロジック(行609-632)を移植したもの。
 * angular_velocityはpi/6〜pi/2にクランプした上で、符号を反転させて格納する
 * (元実装の挙動をそのまま踏襲。符号が0の場合は反転を行わない)。
 */
export function distortShot(
  shotInfo: ShotInfoInput,
  player: PlayerDistortionParams,
): DistortedShotResult {
  const translationalVelocity = Math.max(
    Math.min(shotInfo.translationalVelocity, player.maxVelocity) +
      randomNormal(0, player.shotStdDev),
    0.0,
  );

  const angularVelocitySign = Math.sign(shotInfo.angularVelocity);
  let angularVelocity = Math.max(
    Math.min(Math.abs(shotInfo.angularVelocity), Math.PI / 2),
    Math.PI / 6,
  );
  let actualAngularVelocity = shotInfo.angularVelocity;

  if (angularVelocitySign !== 0) {
    angularVelocity *= -angularVelocitySign;
    actualAngularVelocity *= -angularVelocitySign;
  }

  const shotAngle = shotInfo.shotAngle + randomNormal(0, player.angleStdDev);

  return {
    translationalVelocity,
    shotAngle,
    angularVelocity,
    actualAngularVelocity,
  };
}
