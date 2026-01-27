/**
 * AudioEngine - Singleton class managing all Web Audio API operations
 * Supports dynamic oscillator count (2-10), multi-channel routing, and device selection.
 * Isolated from React to prevent re-renders from interfering with audio timing.
 */

class AudioEngine {
  constructor() {
    if (AudioEngine.instance) {
      return AudioEngine.instance;
    }
    
    this.AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioContext = null;
    this.oscillators = [];
    this.gainNodes = [];         // Volume control per oscillator
    this.routingNodes = [];      // Routing control per oscillator (for channel assignment)
    this.masterGainNode = null;
    this.analyserNode1 = null;   // Left channel visualization
    this.analyserNode2 = null;   // Right channel visualization
    this.isInitialized = false;
    this.isPaused = false;
    
    // Dynamic oscillator management
    this.oscillatorCount = 2;
    this.maxOscillators = 10;
    this.minOscillators = 2;
    
    // Store frequency/volume values separately from oscillator nodes
    this.frequencyValues = [60, 60.3];
    this.volumeValues = [0.5, 0.5];
    this.mutedStates = [false, false];
    this.preMuteVolumes = [0.5, 0.5];
    
    // Multi-channel routing - maps oscillator index to array of output channels
    this.routingMap = {}; // { oscIndex: [outputChannel1, outputChannel2, ...] }
    this.outputChannelCount = 2; // Default stereo
    
    // Device management
    this.currentDeviceId = null;
    
    // Audio graph nodes for routing
    this.channelGains = [];      // One gain per output channel for final mixing
    this.stereoMerger = null;    // Merges channels to stereo for output
    
    // Callbacks for state change notifications
    this.onRoutingChange = null;
    
    AudioEngine.instance = this;
  }
  
  /**
   * Initialize the audio context and create all nodes
   * Must be called from a user gesture (click/touch)
   */
  initialize(initialFrequencies = null, initialVolumes = null) {
    if (this.isInitialized) return;
    
    // Apply initial values if provided (e.g., from URL)
    if (initialFrequencies && initialFrequencies.length >= 2) {
      this.oscillatorCount = Math.min(initialFrequencies.length, this.maxOscillators);
      this.frequencyValues = initialFrequencies.slice(0, this.oscillatorCount);
    }
    if (initialVolumes && initialVolumes.length >= 2) {
      this.volumeValues = initialVolumes.slice(0, this.oscillatorCount).map(v => v / 100);
    }
    
    // Ensure arrays are properly sized
    while (this.frequencyValues.length < this.oscillatorCount) {
      this.frequencyValues.push(60);
    }
    while (this.volumeValues.length < this.oscillatorCount) {
      this.volumeValues.push(0.5);
    }
    while (this.mutedStates.length < this.oscillatorCount) {
      this.mutedStates.push(false);
    }
    while (this.preMuteVolumes.length < this.oscillatorCount) {
      this.preMuteVolumes.push(0.5);
    }
    
    this.audioContext = new this.AudioContextClass();
    
    // Create analyser nodes for visualization
    this.analyserNode1 = this.audioContext.createAnalyser();
    this.analyserNode2 = this.audioContext.createAnalyser();
    this.analyserNode1.fftSize = 2048;
    this.analyserNode2.fftSize = 2048;
    
    // Pre-allocate Float32Arrays for visualization
    this.timeData1 = new Float32Array(this.analyserNode1.fftSize);
    this.timeData2 = new Float32Array(this.analyserNode2.fftSize);
    
    // Create master gain node
    this.masterGainNode = this.audioContext.createGain();
    this.masterGainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    
    // Create channel gain nodes (one per output channel for mixing)
    this.channelGains = [
      this.audioContext.createGain(), // Left channel
      this.audioContext.createGain()  // Right channel
    ];
    
    // Create stereo merger
    this.stereoMerger = this.audioContext.createChannelMerger(2);
    
    // Connect channel gains to stereo merger
    this.channelGains[0].connect(this.stereoMerger, 0, 0); // Left
    this.channelGains[1].connect(this.stereoMerger, 0, 1); // Right
    
    // Connect stereo merger to master gain
    this.stereoMerger.connect(this.masterGainNode);
    
    // Create splitter for visualization (after master gain)
    const splitter = this.audioContext.createChannelSplitter(2);
    const finalMerger = this.audioContext.createChannelMerger(2);
    
    this.masterGainNode.connect(splitter);
    splitter.connect(this.analyserNode1, 0);
    splitter.connect(this.analyserNode2, 1);
    this.analyserNode1.connect(finalMerger, 0, 0);
    this.analyserNode2.connect(finalMerger, 0, 1);
    finalMerger.connect(this.audioContext.destination);
    
    // Get max channel count from destination
    this.outputChannelCount = this.audioContext.destination.maxChannelCount || 2;
    console.log('Max output channels available:', this.outputChannelCount);
    
    // Create initial oscillators with default routing
    this._createOscillators();
    
    // Setup default routing (odd → left, even → right)
    this._setupDefaultRouting();
    
    // Fade in
    this.masterGainNode.gain.setTargetAtTime(this._getScaledMasterGain(), this.audioContext.currentTime, 0.1);
    
    this.isInitialized = true;
    this.isPaused = false;
  }
  
  /**
   * Get scaled master gain based on oscillator count to prevent clipping
   */
  _getScaledMasterGain() {
    return 1.0 / Math.sqrt(this.oscillatorCount / 2);
  }
  
  /**
   * Update master gain scaling when oscillator count changes
   */
  _updateMasterGainScaling() {
    if (!this.isInitialized || this.isPaused) return;
    
    const targetGain = this._getScaledMasterGain();
    this.masterGainNode.gain.setTargetAtTime(
      targetGain,
      this.audioContext.currentTime,
      0.1
    );
  }
  
  /**
   * Create oscillators based on current count
   */
  _createOscillators() {
    for (let i = 0; i < this.oscillatorCount; i++) {
      this._createSingleOscillator(i);
    }
  }
  
  /**
   * Create a single oscillator at the specified index
   */
  _createSingleOscillator(index) {
    try {
      if (!this.audioContext) {
        console.error('AudioEngine: Cannot create oscillator - audio context not ready');
        return;
      }
      
      const oscillator = this.audioContext.createOscillator();
      const gainNode = this.audioContext.createGain();
      
      oscillator.connect(gainNode);
      
      // Default routing: odd indices → left (0), even indices → right (1)
      const defaultChannel = index % 2;
      this.routingMap[index] = [defaultChannel];
      
      // Connect to the appropriate channel gain
      gainNode.connect(this.channelGains[defaultChannel]);
      
      // Set initial frequency and volume
      const freq = this.frequencyValues[index] || 60;
      const vol = this.mutedStates[index] ? 0 : (this.volumeValues[index] || 0.5);
      
      oscillator.frequency.setValueAtTime(freq, this.audioContext.currentTime);
      gainNode.gain.setValueAtTime(vol, this.audioContext.currentTime);
      
      oscillator.start();
      
      this.oscillators[index] = oscillator;
      this.gainNodes[index] = gainNode;
    } catch (err) {
      console.error('AudioEngine: Failed to create oscillator', index, err);
    }
  }
  
  /**
   * Setup default routing (odd → left, even → right)
   */
  _setupDefaultRouting() {
    for (let i = 0; i < this.oscillatorCount; i++) {
      this.routingMap[i] = [i % 2]; // 0=left, 1=right as array
    }
  }
  
  /**
   * Set oscillator count (2-10)
   */
  setOscillatorCount(count) {
    try {
      if (!this.isInitialized) {
        this.oscillatorCount = Math.max(this.minOscillators, Math.min(this.maxOscillators, count));
        return;
      }
      
      const newCount = Math.max(this.minOscillators, Math.min(this.maxOscillators, count));
      
      if (newCount === this.oscillatorCount) return;
      
      const oldCount = this.oscillatorCount;
      
      if (newCount > oldCount) {
        // Add oscillators - update count first so arrays are in sync
        this.oscillatorCount = newCount;
        
        for (let i = oldCount; i < newCount; i++) {
          // Generate random pitch based on existing oscillators ±3 Hz
          const randomIndex = Math.floor(Math.random() * oldCount);
          const basePitch = this.frequencyValues[randomIndex] || 60;
          const newPitch = basePitch + (Math.random() * 6 - 3);
          
          this.frequencyValues[i] = Math.max(0.1, newPitch);
          this.volumeValues[i] = 0.5;
          this.mutedStates[i] = false;
          this.preMuteVolumes[i] = 0.5;
          
          this._createSingleOscillator(i);
        }
      } else {
        // Remove oscillators
        for (let i = oldCount - 1; i >= newCount; i--) {
          try {
            if (this.oscillators[i]) {
              this.oscillators[i].stop();
              this.oscillators[i].disconnect();
            }
            if (this.gainNodes[i]) {
              this.gainNodes[i].disconnect();
            }
          } catch (e) {
            console.warn('Error stopping oscillator', i, e);
          }
          
          this.oscillators.splice(i, 1);
          this.gainNodes.splice(i, 1);
          this.frequencyValues.splice(i, 1);
          this.volumeValues.splice(i, 1);
          this.mutedStates.splice(i, 1);
          this.preMuteVolumes.splice(i, 1);
          delete this.routingMap[i];
        }
        
        this.oscillatorCount = newCount;
      }
      
      // Update master gain scaling to prevent clipping
      this._updateMasterGainScaling();
    } catch (err) {
      console.error('AudioEngine: Failed to set oscillator count', err);
    }
  }
  
  /**
   * Get current oscillator count
   */
  getOscillatorCount() {
    return this.oscillatorCount;
  }
  
  /**
   * Add routing for an oscillator to a specific output channel
   * @param {number} oscIndex - Oscillator index (0-based)
   * @param {number} outputChannel - Output channel to add
   */
  addRouting(oscIndex, outputChannel) {
    if (!this.isInitialized) return;
    if (oscIndex < 0 || oscIndex >= this.oscillatorCount) return;
    if (!this.gainNodes[oscIndex]) return;
    if (outputChannel === null || outputChannel === undefined) return;
    
    const channels = this.routingMap[oscIndex] || [];
    const newChannel = Math.max(0, Math.min(outputChannel, this.channelGains.length - 1));
    
    // Skip if already routed to this channel
    if (channels.includes(newChannel)) return;
    
    try {
      // Connect to new channel (don't disconnect existing connections)
      this.gainNodes[oscIndex].connect(this.channelGains[newChannel]);
      
      // Update routing map
      this.routingMap[oscIndex] = [...channels, newChannel];
      
      // Notify listeners
      if (this.onRoutingChange) {
        this.onRoutingChange(oscIndex, this.routingMap[oscIndex]);
      }
    } catch (err) {
      console.error('AudioEngine: Failed to add routing', err);
    }
  }
  
  /**
   * Remove routing for an oscillator from a specific output channel
   * @param {number} oscIndex - Oscillator index (0-based)
   * @param {number} outputChannel - Output channel to remove
   */
  removeRouting(oscIndex, outputChannel) {
    if (!this.isInitialized) return;
    if (oscIndex < 0 || oscIndex >= this.oscillatorCount) return;
    if (!this.gainNodes[oscIndex]) return;
    
    const channels = this.routingMap[oscIndex] || [];
    const channelIndex = channels.indexOf(outputChannel);
    
    if (channelIndex === -1) return;
    
    try {
      // Disconnect from all channels and reconnect to remaining ones
      this.gainNodes[oscIndex].disconnect();
      
      // Update routing map - just remove the channel, don't reassign
      const newChannels = channels.filter(ch => ch !== outputChannel);
      this.routingMap[oscIndex] = newChannels;
      
      // Reconnect to remaining channels (if any)
      for (const ch of newChannels) {
        this.gainNodes[oscIndex].connect(this.channelGains[ch]);
      }
      
      // If no channels left, oscillator is disconnected (silent) - that's okay
      
      // Notify listeners
      if (this.onRoutingChange) {
        this.onRoutingChange(oscIndex, this.routingMap[oscIndex]);
      }
    } catch (err) {
      console.error('AudioEngine: Failed to remove routing', err);
    }
  }
  
  /**
   * Clear all routings going to a specific output channel
   * @param {number} outputChannel - Output channel to clear
   */
  clearOutputChannel(outputChannel) {
    if (!this.isInitialized) return;
    
    for (let oscIndex = 0; oscIndex < this.oscillatorCount; oscIndex++) {
      const channels = this.routingMap[oscIndex] || [];
      if (channels.includes(outputChannel)) {
        this.removeRouting(oscIndex, outputChannel);
      }
    }
  }
  
  /**
   * Set routing for an oscillator (legacy - now adds to existing routings)
   * @param {number} oscIndex - Oscillator index (0-based)
   * @param {number|null} outputChannel - Output channel to add
   */
  setRouting(oscIndex, outputChannel) {
    this.addRouting(oscIndex, outputChannel);
  }
  
  /**
   * Get current routing map
   */
  getRoutingMap() {
    return { ...this.routingMap };
  }
  
  /**
   * Get max output channels available
   */
  getMaxOutputChannels() {
    if (!this.isInitialized) return 2;
    return this.outputChannelCount;
  }
  
  /**
   * Set output device
   */
  async setOutputDevice(deviceId) {
    if (!this.isInitialized) {
      this.currentDeviceId = deviceId;
      return;
    }
    
    if (typeof this.audioContext.setSinkId === 'function') {
      try {
        await this.audioContext.setSinkId(deviceId);
        this.currentDeviceId = deviceId;
        
        // Update channel count after device change
        const newChannelCount = this.audioContext.destination.maxChannelCount || 2;
        console.log('New device channel count:', newChannelCount);
        
        if (newChannelCount !== this.outputChannelCount) {
          this.outputChannelCount = newChannelCount;
          this._rebuildChannelRouting();
        }
      } catch (err) {
        console.error('Failed to set output device:', err);
      }
    } else {
      console.warn('setSinkId not supported in this browser');
    }
  }
  
  /**
   * Rebuild channel routing for new channel count
   */
  _rebuildChannelRouting() {
    if (!this.isInitialized) return;
    
    console.log('Rebuilding channel routing for', this.outputChannelCount, 'channels');
    
    // Disconnect all oscillator gain nodes from current channel gains
    for (let i = 0; i < this.gainNodes.length; i++) {
      if (this.gainNodes[i]) {
        try {
          this.gainNodes[i].disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
      }
    }
    
    // Disconnect old channel gains from merger
    for (const channelGain of this.channelGains) {
      try {
        channelGain.disconnect();
      } catch (e) {
        // Ignore
      }
    }
    
    // Disconnect old merger
    if (this.stereoMerger) {
      try {
        this.stereoMerger.disconnect();
      } catch (e) {
        // Ignore
      }
    }
    
    // Create new channel gains for all output channels (but we still visualize as stereo)
    // Channels 0,2,4... go to left visualizer, 1,3,5... go to right visualizer
    const numChannels = Math.min(this.outputChannelCount, 32); // Reasonable limit
    
    // Create new channel gains
    this.channelGains = [];
    for (let i = 0; i < numChannels; i++) {
      this.channelGains.push(this.audioContext.createGain());
    }
    
    // Create new merger with correct channel count
    this.stereoMerger = this.audioContext.createChannelMerger(numChannels);
    
    // Connect channel gains to merger
    for (let i = 0; i < numChannels; i++) {
      this.channelGains[i].connect(this.stereoMerger, 0, i);
    }
    
    // Connect merger to master gain
    this.stereoMerger.connect(this.masterGainNode);
    
    // Re-setup default routing for current oscillators
    this._setupDefaultRouting();
    
    // Reconnect all oscillator gain nodes to their channel gains
    for (let i = 0; i < this.gainNodes.length; i++) {
      if (this.gainNodes[i]) {
        const channels = this.routingMap[i] || [i % numChannels];
        for (const ch of channels) {
          if (ch < this.channelGains.length) {
            this.gainNodes[i].connect(this.channelGains[ch]);
          }
        }
      }
    }
    
    console.log('Channel routing rebuilt for', numChannels, 'channels');
  }
  
  /**
   * Get available audio output devices
   */
  async getAudioOutputDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'audiooutput');
    } catch (err) {
      console.error('Failed to enumerate devices:', err);
      return [];
    }
  }
  
  /**
   * Set frequency for a specific oscillator
   */
  setFrequency(index, frequency) {
    if (!this.isInitialized || index < 0 || index >= this.oscillatorCount) return;
    if (!this.oscillators[index]) return;
    
    const clampedFreq = Math.max(0.001, Math.min(20000, frequency));
    
    if (Math.abs(clampedFreq - this.frequencyValues[index]) < 0.01) return;
    
    this.frequencyValues[index] = clampedFreq;
    
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    
    this.oscillators[index].frequency.setTargetAtTime(
      clampedFreq,
      this.audioContext.currentTime,
      0.016
    );
  }
  
  /**
   * Set volume for a specific oscillator (0-1 range)
   */
  setVolume(index, volume) {
    if (!this.isInitialized || index < 0 || index >= this.oscillatorCount) return;
    if (!this.gainNodes[index]) return;
    
    const clampedVol = Math.max(0, Math.min(1, volume));
    
    if (Math.abs(clampedVol - this.volumeValues[index]) < 0.005) return;
    
    this.volumeValues[index] = clampedVol;
    
    if (this.mutedStates[index]) {
      this.preMuteVolumes[index] = clampedVol;
      return;
    }
    
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
    return this.frequencyValues[index] || 0;
  }
  
  /**
   * Get current volume value for an oscillator (0-1)
   */
  getVolume(index) {
    return this.volumeValues[index] || 0;
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
    return this.mutedStates[index] || false;
  }
  
  /**
   * Mute a specific oscillator with fade
   */
  muteOscillator(index) {
    if (!this.isInitialized || index < 0 || index >= this.oscillatorCount) return;
    if (this.mutedStates[index]) return;
    if (!this.gainNodes[index]) return;
    
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
    if (!this.isInitialized || index < 0 || index >= this.oscillatorCount) return;
    if (!this.mutedStates[index]) return;
    if (!this.gainNodes[index]) return;
    
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
   * @returns {Promise} Resolves when fade is complete
   */
  fadeOut() {
    if (!this.isInitialized) return Promise.resolve();
    
    const fadeDuration = 0.3; // 300ms fade
    const currentTime = this.audioContext.currentTime;
    this.masterGainNode.gain.cancelScheduledValues(currentTime);
    const currentGain = this.masterGainNode.gain.value;
    this.masterGainNode.gain.setValueAtTime(Math.max(currentGain, 0.001), currentTime);
    this.masterGainNode.gain.exponentialRampToValueAtTime(0.001, currentTime + fadeDuration);
    this.masterGainNode.gain.setValueAtTime(0, currentTime + fadeDuration);
    
    this.isPaused = true;
    
    return new Promise(resolve => setTimeout(resolve, fadeDuration * 1000));
  }
  
  /**
   * Fade in master volume
   * @returns {Promise} Resolves when fade is complete
   */
  fadeIn() {
    if (!this.isInitialized) return Promise.resolve();
    
    const fadeDuration = 0.5; // 500ms fade
    const currentTime = this.audioContext.currentTime;
    const targetGain = this._getScaledMasterGain();
    
    this.masterGainNode.gain.cancelScheduledValues(currentTime);
    this.masterGainNode.gain.setValueAtTime(0.001, currentTime);
    this.masterGainNode.gain.exponentialRampToValueAtTime(targetGain, currentTime + fadeDuration);
    
    this.isPaused = false;
    
    return new Promise(resolve => setTimeout(resolve, fadeDuration * 1000));
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
   */
  getTimeDataLeft() {
    if (!this.isInitialized) return null;
    
    this.analyserNode1.getFloatTimeDomainData(this.timeData1);
    return this.timeData1;
  }
  
  /**
   * Get time domain data for visualization (right channel)
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
