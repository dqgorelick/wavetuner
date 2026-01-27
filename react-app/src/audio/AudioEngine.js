/**
 * AudioEngine - Singleton class managing all Web Audio API operations
 * This module is completely isolated from React to prevent re-renders
 * from interfering with audio timing and quality.
 */

class AudioEngine {
  constructor() {
    if (AudioEngine.instance) {
      return AudioEngine.instance;
    }
    
    this.AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioContext = null;
    this.oscillators = [];
    this.gainNodes = [];
    this.masterGainNode = null;
    this.analyserNode1 = null;
    this.analyserNode2 = null;
    this.isInitialized = false;
    this.isPaused = false;
    
    // Store frequency values separately from oscillator nodes
    // This allows reading current values without querying audio params
    this.frequencyValues = [60, 60.3, 60, 60];
    this.volumeValues = [0.5, 0.5, 0, 0];
    this.mutedStates = [false, false, false, false];
    this.preMuteVolumes = [0.5, 0.5, 0, 0]; // Store volumes before muting
    
    // Callbacks for UI updates (optional)
    this.onStateChange = null;
    
    AudioEngine.instance = this;
  }
  
  /**
   * Initialize the audio context and create all nodes
   * Must be called from a user gesture (click/touch)
   */
  initialize(initialFrequencies = null, initialVolumes = null) {
    if (this.isInitialized) return;
    
    // Apply initial values if provided (e.g., from URL)
    if (initialFrequencies) {
      this.frequencyValues = [...initialFrequencies];
    }
    if (initialVolumes) {
      this.volumeValues = initialVolumes.map(v => v / 100);
    }
    
    this.audioContext = new this.AudioContextClass();
    
    // Create analyser nodes for visualization
    // fftSize = 2048 matches the original (16384 / 8)
    this.analyserNode1 = this.audioContext.createAnalyser();
    this.analyserNode2 = this.audioContext.createAnalyser();
    this.analyserNode1.fftSize = 2048;
    this.analyserNode2.fftSize = 2048;
    
    // Pre-allocate Float32Arrays to avoid GC during animation
    this.timeData1 = new Float32Array(this.analyserNode1.fftSize);
    this.timeData2 = new Float32Array(this.analyserNode2.fftSize);
    
    // Create master gain node
    this.masterGainNode = this.audioContext.createGain();
    this.masterGainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    
    // Create stereo merger for combining oscillators
    const oscMerger = this.audioContext.createChannelMerger(2);
    
    // Create final merger for audio output
    const finalMerger = this.audioContext.createChannelMerger(2);
    
    // Create 4 oscillators with gain nodes
    for (let i = 0; i < 4; i++) {
      const oscillator = this.audioContext.createOscillator();
      const gainNode = this.audioContext.createGain();
      
      oscillator.connect(gainNode);
      
      // Route to left (0, 2) or right (1, 3) channel
      if (i === 0 || i === 2) {
        gainNode.connect(oscMerger, 0, 0); // Left channel
      } else {
        gainNode.connect(oscMerger, 0, 1); // Right channel
      }
      
      // Set initial frequency and volume
      oscillator.frequency.setValueAtTime(
        this.frequencyValues[i],
        this.audioContext.currentTime
      );
      gainNode.gain.setValueAtTime(
        this.volumeValues[i],
        this.audioContext.currentTime
      );
      
      oscillator.start();
      
      this.oscillators.push(oscillator);
      this.gainNodes.push(gainNode);
    }
    
    // Connect merger to master gain
    oscMerger.connect(this.masterGainNode);
    
    // Split for analyzers
    const splitter = this.audioContext.createChannelSplitter(2);
    this.masterGainNode.connect(splitter);
    
    // Connect each channel to its analyzer
    splitter.connect(this.analyserNode1, 0);
    splitter.connect(this.analyserNode2, 1);
    
    // Connect analyzers to final merger
    this.analyserNode1.connect(finalMerger, 0, 0);
    this.analyserNode2.connect(finalMerger, 0, 1);
    
    // Connect to destination
    finalMerger.connect(this.audioContext.destination);
    
    // Fade in
    this.masterGainNode.gain.setTargetAtTime(1, this.audioContext.currentTime, 0.1);
    
    this.isInitialized = true;
    this.isPaused = false;
  }
  
  /**
   * Set frequency for a specific oscillator
   * Uses setTargetAtTime for smooth, click-free transitions
   * Includes change detection to avoid unnecessary automation calls
   */
  setFrequency(index, frequency) {
    if (!this.isInitialized || index < 0 || index > 3) return;
    
    const clampedFreq = Math.max(0.001, Math.min(1000, frequency));
    
    // Only update if change is significant (reduces automation buildup)
    if (Math.abs(clampedFreq - this.frequencyValues[index]) < 0.01) return;
    
    this.frequencyValues[index] = clampedFreq;
    
    // Resume audio context if suspended (browser power saving)
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    
    this.oscillators[index].frequency.setTargetAtTime(
      clampedFreq,
      this.audioContext.currentTime,
      0.016 // ~16ms time constant (one frame)
    );
  }
  
  /**
   * Set volume for a specific oscillator (0-1 range)
   */
  setVolume(index, volume) {
    if (!this.isInitialized || index < 0 || index > 3) return;
    
    const clampedVol = Math.max(0, Math.min(1, volume));
    
    // Only update if change is significant
    if (Math.abs(clampedVol - this.volumeValues[index]) < 0.005) return;
    
    this.volumeValues[index] = clampedVol;
    
    // If muted, don't actually change the gain, just store the value
    if (this.mutedStates[index]) {
      this.preMuteVolumes[index] = clampedVol;
      return;
    }
    
    // Resume audio context if suspended
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    
    this.gainNodes[index].gain.setTargetAtTime(
      clampedVol,
      this.audioContext.currentTime,
      0.016
    );
  }
  
  /**
   * Get current frequency value for an oscillator
   */
  getFrequency(index) {
    return this.frequencyValues[index];
  }
  
  /**
   * Get current volume value for an oscillator (0-1)
   */
  getVolume(index) {
    return this.volumeValues[index];
  }
  
  /**
   * Get all frequencies
   */
  getAllFrequencies() {
    return [...this.frequencyValues];
  }
  
  /**
   * Get all volumes (as percentages 0-100)
   */
  getAllVolumes() {
    return this.volumeValues.map(v => Math.round(v * 100));
  }
  
  /**
   * Get muted state for all oscillators
   */
  getAllMutedStates() {
    return [...this.mutedStates];
  }
  
  /**
   * Check if an oscillator is muted
   */
  isMuted(index) {
    return this.mutedStates[index];
  }
  
  /**
   * Mute a specific oscillator with fade
   */
  muteOscillator(index) {
    if (!this.isInitialized || index < 0 || index > 3) return;
    if (this.mutedStates[index]) return; // Already muted
    
    this.mutedStates[index] = true;
    this.preMuteVolumes[index] = this.volumeValues[index];
    
    const currentTime = this.audioContext.currentTime;
    const gainNode = this.gainNodes[index];
    
    gainNode.gain.cancelScheduledValues(currentTime);
    const currentGain = gainNode.gain.value;
    gainNode.gain.setValueAtTime(Math.max(currentGain, 0.001), currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, currentTime + 0.3);
    gainNode.gain.setValueAtTime(0, currentTime + 0.3);
  }
  
  /**
   * Unmute a specific oscillator with fade
   */
  unmuteOscillator(index) {
    if (!this.isInitialized || index < 0 || index > 3) return;
    if (!this.mutedStates[index]) return; // Not muted
    
    this.mutedStates[index] = false;
    const targetVolume = this.volumeValues[index];
    
    const currentTime = this.audioContext.currentTime;
    const gainNode = this.gainNodes[index];
    
    gainNode.gain.cancelScheduledValues(currentTime);
    gainNode.gain.setValueAtTime(0.001, currentTime);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(targetVolume, 0.001), currentTime + 0.3);
  }
  
  /**
   * Toggle mute for a specific oscillator
   */
  toggleMute(index) {
    if (this.mutedStates[index]) {
      this.unmuteOscillator(index);
    } else {
      this.muteOscillator(index);
    }
    return this.mutedStates[index];
  }
  
  /**
   * Fade out master volume
   */
  fadeOut() {
    if (!this.isInitialized) return;
    
    const currentTime = this.audioContext.currentTime;
    this.masterGainNode.gain.cancelScheduledValues(currentTime);
    const currentGain = this.masterGainNode.gain.value;
    this.masterGainNode.gain.setValueAtTime(currentGain, currentTime);
    this.masterGainNode.gain.exponentialRampToValueAtTime(0.001, currentTime + 0.5);
    this.masterGainNode.gain.setValueAtTime(0, currentTime + 0.5);
    
    this.isPaused = true;
  }
  
  /**
   * Fade in master volume
   */
  fadeIn() {
    if (!this.isInitialized) return;
    
    const currentTime = this.audioContext.currentTime;
    this.masterGainNode.gain.cancelScheduledValues(currentTime);
    this.masterGainNode.gain.setValueAtTime(0.001, currentTime);
    this.masterGainNode.gain.exponentialRampToValueAtTime(1, currentTime + 1);
    
    this.isPaused = false;
  }
  
  /**
   * Toggle play/pause
   */
  togglePlayPause() {
    if (!this.isInitialized) return;
    
    if (this.isPaused) {
      this.fadeIn();
    } else {
      this.fadeOut();
    }
    
    return this.isPaused;
  }
  
  /**
   * Get time domain data for visualization (left channel)
   * Reuses pre-allocated array to avoid GC pressure
   */
  getTimeDataLeft() {
    if (!this.isInitialized) return null;
    
    this.analyserNode1.getFloatTimeDomainData(this.timeData1);
    return this.timeData1;
  }
  
  /**
   * Get time domain data for visualization (right channel)
   * Reuses pre-allocated array to avoid GC pressure
   */
  getTimeDataRight() {
    if (!this.isInitialized) return null;
    
    this.analyserNode2.getFloatTimeDomainData(this.timeData2);
    return this.timeData2;
  }
  
  /**
   * Check if audio is initialized
   */
  get initialized() {
    return this.isInitialized;
  }
  
  /**
   * Check if audio is paused
   */
  get paused() {
    return this.isPaused;
  }
}

// Export singleton instance
const audioEngine = new AudioEngine();
export default audioEngine;
