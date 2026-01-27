import { useEffect, useRef } from 'react';
import audioEngine from '../audio/AudioEngine';

/**
 * Oscilloscope component - Canvas-based visualization
 * Uses refs and imperative animation loop to avoid React re-render overhead
 */
export default function Oscilloscope() {
  const canvasRef = useRef(null);
  const animationFrameRef = useRef(null);
  const dimensionsRef = useRef({ width: 0, height: 0, scaleX: 1, scaleY: 1 });
  
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    // Resize handler
    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      dimensionsRef.current = {
        width: canvas.width,
        height: canvas.height,
        scaleX: canvas.width / 1024,
        scaleY: canvas.height / 1024
      };
    };
    
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    // Pre-calculate constants for color cycling
    const TWO_PI = 2 * Math.PI;
    const PHASE_OFFSET = TWO_PI / 3;
    const CYCLE_TIME = 20 * 60 * 1000;
    
    // Animation loop - runs independently of React
    // Matches original: iterates all points, no sampling
    const drawScope = () => {
      animationFrameRef.current = requestAnimationFrame(drawScope);
      
      if (!audioEngine.initialized) return;
      
      const { width, height, scaleX, scaleY } = dimensionsRef.current;
      
      const timeData1 = audioEngine.getTimeDataLeft();
      const timeData2 = audioEngine.getTimeDataRight();
      
      if (!timeData1 || !timeData2) return;
      
      // Clear with fade effect
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(0, 0, width, height);
      
      // Calculate color based on 20-minute cycle
      const position = (Date.now() % CYCLE_TIME) / CYCLE_TIME;
      const angle = position * TWO_PI;
      
      const r = Math.sin(angle) * 127 + 128;
      const g = Math.sin(angle + PHASE_OFFSET) * 127 + 128;
      const b = Math.sin(angle + PHASE_OFFSET * 2) * 127 + 128;
      
      // Pre-calculate scope dimensions (matches original formula)
      const scopeSize = Math.min(width, height) * 0.9;
      const scopeOffsetX = (width - scopeSize) / 2;
      const scopeOffsetY = (height - scopeSize) / 2;
      
      const lineScale = Math.min(scaleX, scaleY);
      const dataLen = timeData1.length;
      
      // Detect waveform complexity by counting direction changes (proxy for frequency)
      let directionChanges = 0;
      let prevDiff = 0;
      for (let i = 2; i < Math.min(dataLen, 256); i++) {
        const diff = timeData1[i] - timeData1[i - 1];
        if ((diff > 0 && prevDiff < 0) || (diff < 0 && prevDiff > 0)) {
          directionChanges++;
        }
        prevDiff = diff;
      }
      
      // Calculate adaptive parameters based on complexity
      // More direction changes = higher frequency = need more adaptation
      const complexity = Math.min(directionChanges / 50, 1); // Normalize to 0-1
      
      // Adaptive sampling: sample fewer points at high frequencies
      const minStep = 1;
      const maxStep = 8;
      const sampleStep = Math.round(minStep + complexity * (maxStep - minStep));
      
      // Adaptive line width: thicker at high frequencies
      const baseColorWidth = 20;
      const baseWhiteWidth = 5;
      const colorWidth = (baseColorWidth + complexity * 10) * lineScale;
      const whiteWidth = (baseWhiteWidth + complexity * 3) * lineScale;
      
      // Adaptive smoothing: more smoothing at high frequencies
      const baseSmoothingFactor = 0.6;
      const smoothingFactor = baseSmoothingFactor + complexity * 0.3;
      
      // Draw colored line (with smoothing) - with glow effect
      ctx.beginPath();
      ctx.lineWidth = colorWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, 1)`;
      
      // Add glow via canvas shadow - constant at all frequencies
      ctx.shadowBlur = 25 * lineScale;
      ctx.shadowColor = `rgba(${r | 0}, ${g | 0}, ${b | 0}, 0.8)`;
      
      let prevX = null;
      let prevY = null;
      
      for (let i = 0; i < dataLen; i += sampleStep) {
        let x1 = ((timeData1[i] + 1) / 2) * scopeSize + scopeOffsetX;
        let y1 = ((timeData2[i] + 1) / 2) * scopeSize + scopeOffsetY;
        
        if (prevX !== null && prevY !== null) {
          x1 = prevX * smoothingFactor + x1 * (1 - smoothingFactor);
          y1 = prevY * smoothingFactor + y1 * (1 - smoothingFactor);
        }
        
        if (i === 0) {
          ctx.moveTo(x1, y1);
        } else {
          ctx.lineTo(x1, y1);
        }
        
        prevX = x1;
        prevY = y1;
      }
      ctx.stroke();
      
      // Draw white line (with light smoothing at high freq) - with subtle glow
      ctx.beginPath();
      ctx.lineWidth = whiteWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
      ctx.shadowBlur = 10 * lineScale;
      ctx.shadowColor = 'rgba(255, 255, 255, 0.6)';
      
      prevX = null;
      prevY = null;
      
      // Use same smoothing as colored line to keep them aligned
      for (let i = 0; i < dataLen; i += sampleStep) {
        let x1 = ((timeData1[i] + 1) / 2) * scopeSize + scopeOffsetX;
        let y1 = ((timeData2[i] + 1) / 2) * scopeSize + scopeOffsetY;
        
        if (prevX !== null && prevY !== null) {
          x1 = prevX * smoothingFactor + x1 * (1 - smoothingFactor);
          y1 = prevY * smoothingFactor + y1 * (1 - smoothingFactor);
        }
        
        if (i === 0) {
          ctx.moveTo(x1, y1);
        } else {
          ctx.lineTo(x1, y1);
        }
        
        prevX = x1;
        prevY = y1;
      }
      ctx.stroke();
      
      // Reset shadow to avoid affecting the clear rect
      ctx.shadowBlur = 0;
    };
    
    // Start animation loop
    drawScope();
    
    // Cleanup
    return () => {
      window.removeEventListener('resize', resizeCanvas);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);
  
  return (
    <div className="oscilloscope-container">
      <canvas ref={canvasRef} id="scope" />
    </div>
  );
}
