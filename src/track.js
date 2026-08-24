/**
 * The race track: one simple closed circuit.
 *
 * The track is 1000 m (five 200 m sectors). Cars are located by
 * `distTraveled` (total meters since the grid) and `position` (meters into
 * the current lap, 0 <= position < lengthM).
 *
 * `id` identifies the track in the `tracks/` registry (MCPG-27) so the
 * spectator client can fetch the matching visual definition.
 */
export class Track {
  constructor({ id = 'ring', name = 'Grand Prix Ring', lengthM = 1000, sectorLengthM = 200 } = {}) {
    if (lengthM % sectorLengthM !== 0) {
      throw new Error('sectorLengthM must divide lengthM evenly');
    }
    this.id = id;
    this.name = name;
    this.lengthM = lengthM;
    this.sectorLengthM = sectorLengthM;
    this.sectorCount = lengthM / sectorLengthM;
  }

  info() {
    return {
      id: this.id,
      name: this.name,
      lengthM: this.lengthM,
      sectorLengthM: this.sectorLengthM,
      sectorCount: this.sectorCount,
    };
  }

  /** Meter position within the current lap. */
  lapPosition(distTraveled) {
    const p = distTraveled % this.lengthM;
    return p === 0 && distTraveled > 0 ? this.lengthM : p;
  }

  /** 1-based sector number for a lap position. */
  sectorForPosition(positionM) {
    const s = Math.floor(positionM / this.sectorLengthM) + 1;
    return Math.min(s, this.sectorCount);
  }

  /** Completed laps for a total distance. */
  lapsCompleted(distTraveled) {
    return Math.floor(distTraveled / this.lengthM);
  }

  /** Signed gap (meters) from car a to car b, positive when b is ahead. */
  gapM(aDist, bDist) {
    return bDist - aDist;
  }
}
