# Active Noise Cancellation & Frequency Masking

## How ANC Headphones Work

ANC is processed **entirely in the headphone hardware**:
1. External microphones on the earbuds capture ambient sound
2. The headphone's onboard DSP generates an anti-phase signal
3. The anti-phase signal is mixed into the driver, canceling ambient sound
4. **The phone has zero access to ANC data** -- no APIs exist to read ANC mic input or control the anti-phase signal

## How Your App Fits In

```
                    ANC Headphone
                    ============
Ambient Sound ----> [External Mics] ----> [ANC DSP] ----> [Anti-phase signal]
                                                                   |
                                                                   v
Phone App Output -----------------------------------------> [Driver/Speaker]
                                                                   |
                                                                   v
                                                              [Your Ears]
```

Your app's audio is "inside" the ANC loop:
- ANC cancels external ambient sound
- Your sine waves play through the driver alongside the anti-phase signal
- **ANC will NOT cancel your app's output** -- only external sound

This is actually **ideal** for the use case:
- ANC reduces the overall ambient noise floor
- Your app adds precisely targeted frequencies on top
- The combination creates a curated sonic environment

## True ANC vs. Frequency Masking

### True Active Noise Cancellation (NOT feasible via app)
- Requires phase-accurate cancellation at microsecond precision
- Even 1ms of latency makes cancellation ineffective above ~500Hz
- Phone -> headphone latency is 10-30ms minimum
- Would only theoretically work for very low frequencies (< 100Hz)

### Frequency Masking (YOUR approach -- feasible and interesting)
Instead of canceling sound, you **mask** it by generating tones at or near detected frequencies:

**"Drown out" mode**: Generate sine waves at frequencies where unwanted sound exists
- Detect speech frequencies (85-255 Hz fundamental, 1-4 kHz harmonics)
- Generate drones at those frequencies, raising the masking threshold
- The brain perceives the drone, not the speech (psychoacoustic masking)

**"Play alongside" mode**: Generate sine waves at frequencies where desired sound exists
- Detect bird song frequencies (2-8 kHz)
- Generate harmonically related tones that complement rather than mask
- Creates a musical relationship between environment and composition

**"Fill the gaps" mode**: Generate sine waves at frequencies where nothing is happening
- Analyze the spectrum, find quiet frequency bands
- Fill them with gentle drones
- Creates a full-spectrum ambient experience without masking anything

## Psychoacoustic Masking: How It Works

The human auditory system has a property called **simultaneous masking**: a louder sound at one frequency makes nearby quieter sounds inaudible. This is the principle behind MP3 compression.

Key facts:
- A masking tone must be ~10-15 dB louder than the target to fully mask it
- Masking is strongest for frequencies near the masker (within a critical band)
- Critical bandwidth is ~100 Hz at low frequencies, wider at high frequencies
- Low frequencies mask high frequencies more effectively than vice versa

For your app:
- To mask speech (100-4000 Hz), drones at similar frequencies at moderate volume will be effective
- Birds (2000-8000 Hz) are harder to mask because they're high-frequency with rapid transients
- Steady drones are most effective at masking steady sounds; less effective against sharp transients

## Practical Design Implications

### Mic Placement
- The phone's mic captures a different acoustic environment than what reaches your ears (especially with ANC headphones)
- Consider: clip-on external mic near the ear, or accept the phone mic's perspective
- The phone mic is sufficient for "general frequency landscape" analysis

### User Experience
- Show the detected frequency spectrum in real-time (oscilloscope view)
- Let users paint/select frequency bands to mask or harmonize with
- Provide presets: "mask speech," "enhance nature," "fill silence"
- Allow manual override of the generative composition

### Battery and Processing
- Continuous FFT at 60fps is unnecessary -- analyzing 10-20 times per second is sufficient for environmental sounds (which change slowly)
- Sine wave generation is computationally trivial
- Main battery drain: screen (for visualization) and audio hardware being active

## ANC Transparency Mode

Some headphones offer transparency mode (pass-through of external sound). An interesting interaction:
- **ANC on**: Your app drones + silence. Very isolating.
- **Transparency on**: Your app drones + ambient sound passed through. The most interesting mode -- you hear both the environment and the generated composition.
- **ANC off**: Your app drones + natural ambient leakage. Similar to transparency but less controlled.

The app could suggest which headphone mode to use based on the selected masking strategy.
