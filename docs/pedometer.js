// A small step detector for the phone's motion sensor (DeviceMotion).
// It looks for the bounce of each step in the acceleration, and only starts
// counting once it sees a steady walking rhythm, so a shake or a bump isn't a step.
(() => {
  const SENS = { low: 1.0, normal: 0.4, high: 0.25 }; // smallest bounce that counts, m/s²
  const MIN_GAP = 260; // ms: faster than ~3.8 steps a second isn't walking or running
  const MAX_GAP = 2000; // ms: a longer pause means you stopped
  const START_AFTER = 4; // steady steps needed before counting starts

  function create(sensitivity = 'normal') {
    let minTh = SENS[sensitivity] || SENS.normal;
    let gravity = null;
    let smooth = 0;
    let above = false;
    let peak = 0;
    let avgPeak = 0;
    let lastStep = 0;
    let run = 0; // steady steps in a row
    let walking = false;

    // Feed one sensor reading (m/s², including gravity). Returns the new steps it found.
    function feed(ax, ay, az, t) {
      if (ax == null || ay == null || az == null) return 0;
      const mag = Math.sqrt(ax * ax + ay * ay + az * az);
      if (!(mag > 2)) return 0; // empty or broken reading
      gravity = gravity == null ? mag : gravity + (mag - gravity) * 0.02;
      smooth += (mag - gravity - smooth) * 0.35;
      const th = Math.max(minTh, avgPeak * 0.4);
      let found = 0;
      if (!above && smooth > th) {
        above = true;
        peak = smooth;
        const gap = t - lastStep;
        if (gap >= MIN_GAP) {
          if (gap > MAX_GAP) {
            run = 1;
            walking = false;
          } else run++;
          lastStep = t;
          if (walking) found = 1;
          else if (run >= START_AFTER) {
            walking = true;
            found = run; // count the steps it was waiting to be sure about
          }
        }
      } else if (above) {
        peak = Math.max(peak, smooth);
        if (smooth < th * 0.3) {
          above = false;
          avgPeak = avgPeak ? avgPeak * 0.8 + peak * 0.2 : peak;
        }
      }
      if (walking && t - lastStep > MAX_GAP) {
        walking = false;
        run = 0;
      }
      return found;
    }

    return {
      feed,
      setSensitivity(s) {
        minTh = SENS[s] || SENS.normal;
        avgPeak = 0;
      },
      get walking() {
        return walking;
      },
      get lastStep() {
        return lastStep;
      },
    };
  }

  const api = { create };
  if (typeof window !== 'undefined') window.Pedometer = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
