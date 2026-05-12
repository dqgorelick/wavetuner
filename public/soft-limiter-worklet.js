// Soft limiter / saturator worklet for the master bus.
//
// Curve is set via port.postMessage({ curve: <int> }). Drive is an
// a-rate AudioParam so it can be ramped without zipper noise.
//
// Keep this file dependency-free — it is loaded directly by
// audioWorklet.addModule() and runs in the audio rendering thread.

const CURVE_OFF = 0;
const CURVE_TANH = 1;
const CURVE_CUBIC = 2;
const CURVE_SINE = 3;
const CURVE_HARD = 4;

const HALF_PI = Math.PI / 2;

class SoftLimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'drive',
        defaultValue: 1.0,
        minValue: 0.1,
        maxValue: 4.0,
        automationRate: 'a-rate',
      },
    ];
  }

  constructor() {
    super();
    this.curve = CURVE_TANH;
    this.port.onmessage = (e) => {
      const d = e && e.data;
      if (d && typeof d.curve === 'number') {
        this.curve = d.curve | 0;
      }
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    const drive = params.drive;
    const aRate = drive.length > 1;
    const d0 = drive[0];
    const curve = this.curve;

    for (let ch = 0; ch < output.length; ch++) {
      const outC = output[ch];
      const inC = input && input[ch];

      if (!inC) {
        outC.fill(0);
        continue;
      }

      if (curve === CURVE_OFF) {
        // True bypass — drive does not apply.
        outC.set(inC);
        continue;
      }

      if (curve === CURVE_TANH) {
        for (let i = 0; i < outC.length; i++) {
          outC[i] = Math.tanh(inC[i] * (aRate ? drive[i] : d0));
        }
      } else if (curve === CURVE_CUBIC) {
        // 1.5x − 0.5x³, clamped. Linear at small x, smooth knee at ±1.
        for (let i = 0; i < outC.length; i++) {
          let x = inC[i] * (aRate ? drive[i] : d0);
          if (x >= 1) outC[i] = 1;
          else if (x <= -1) outC[i] = -1;
          else outC[i] = 1.5 * x - 0.5 * x * x * x;
        }
      } else if (curve === CURVE_SINE) {
        // sin(x · π/2), clamped. Softest knee of the bunch.
        for (let i = 0; i < outC.length; i++) {
          let x = inC[i] * (aRate ? drive[i] : d0);
          if (x >= 1) outC[i] = 1;
          else if (x <= -1) outC[i] = -1;
          else outC[i] = Math.sin(x * HALF_PI);
        }
      } else if (curve === CURVE_HARD) {
        for (let i = 0; i < outC.length; i++) {
          let x = inC[i] * (aRate ? drive[i] : d0);
          if (x > 1) x = 1;
          else if (x < -1) x = -1;
          outC[i] = x;
        }
      } else {
        // Unknown curve — fail safe to pass-through.
        outC.set(inC);
      }
    }

    return true;
  }
}

registerProcessor('soft-limiter', SoftLimiterProcessor);
