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
      
      // Draw colored line (with smoothing) - with glow effect
      ctx.beginPath();
      ctx.lineWidth = 20 * lineScale;
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, 1)`;
      
      // Add glow via canvas shadow
      ctx.shadowBlur = 25 * lineScale;
      ctx.shadowColor = `rgba(${r | 0}, ${g | 0}, ${b | 0}, 0.8)`;
      
      let prevX = null;
      let prevY = null;
      const smoothingFactor = 0.8;
      
      for (let i = 0; i < dataLen; i++) {
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
      
      // Draw white line (no smoothing) - with subtle glow
      ctx.beginPath();
      ctx.lineWidth = 5 * lineScale;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
      ctx.shadowBlur = 10 * lineScale;
      ctx.shadowColor = 'rgba(255, 255, 255, 0.6)';
      
      for (let i = 0; i < dataLen; i++) {
        const x1 = ((timeData1[i] + 1) / 2) * scopeSize + scopeOffsetX;
        const y1 = ((timeData2[i] + 1) / 2) * scopeSize + scopeOffsetY;
        
        if (i === 0) {
          ctx.moveTo(x1, y1);
        } else {
          ctx.lineTo(x1, y1);
        }
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
