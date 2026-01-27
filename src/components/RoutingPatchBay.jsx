import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * RoutingPatchBay - Visual patch-bay with draggable cables
 * Connects oscillators (left) to output channels (right)
 * Output channels are arranged in columns of 8
 */
export default function RoutingPatchBay({
  oscillatorCount,
  outputChannels,
  routingMap,
  onRoutingChange
}) {
  const svgRef = useRef(null);
  const [dragging, setDragging] = useState(null); // { oscIndex, mousePos }
  const [nodePositions, setNodePositions] = useState({ osc: [], out: [] });
  
  // Constants for layout
  const OUTPUTS_PER_COLUMN = 8;
  const NODE_SPACING = 32; // Vertical spacing between nodes
  const COLUMN_SPACING = 40; // Horizontal spacing between output columns
  
  // Calculate dimensions based on content
  const outputColumns = Math.ceil(outputChannels / OUTPUTS_PER_COLUMN);
  const maxRows = Math.max(oscillatorCount, Math.min(outputChannels, OUTPUTS_PER_COLUMN));
  const dynamicHeight = Math.max(200, (maxRows + 1) * NODE_SPACING + 40);

  // Calculate node positions based on container size
  useEffect(() => {
    const updatePositions = () => {
      if (!svgRef.current) return;
      
      const rect = svgRef.current.getBoundingClientRect();
      const width = rect.width;
      
      const oscPositions = [];
      const outPositions = [];
      
      // Oscillator nodes on left
      for (let i = 0; i < oscillatorCount; i++) {
        oscPositions.push({
          x: 30,
          y: NODE_SPACING * (i + 1) + 10
        });
      }
      
      // Output nodes on right - arranged in columns of 8
      const totalOutputWidth = (outputColumns - 1) * COLUMN_SPACING + 30;
      const outputStartX = width - totalOutputWidth;
      
      for (let i = 0; i < outputChannels; i++) {
        const column = Math.floor(i / OUTPUTS_PER_COLUMN);
        const row = i % OUTPUTS_PER_COLUMN;
        outPositions.push({
          x: outputStartX + column * COLUMN_SPACING,
          y: NODE_SPACING * (row + 1) + 10
        });
      }
      
      setNodePositions({ osc: oscPositions, out: outPositions });
    };
    
    updatePositions();
    window.addEventListener('resize', updatePositions);
    return () => window.removeEventListener('resize', updatePositions);
  }, [oscillatorCount, outputChannels, outputColumns]);

  // Get color for oscillator - matches OscillatorControls colors
  const getOscColor = (index) => {
    const colors = [
      '#ff4136', // 1 - red
      '#2ecc40', // 2 - green
      '#0074d9', // 3 - blue
      '#ffdc00', // 4 - yellow
      '#bb8fce', // 5 - purple
      '#85c1e9', // 6 - light blue
      '#82e0aa', // 7 - mint
      '#f8b500', // 8 - orange
      '#e74c3c', // 9 - coral
      '#1abc9c', // 10 - teal
    ];
    return colors[index % colors.length];
  };

  // Generate cable path with physics-like droop
  const getCablePath = (startX, startY, endX, endY) => {
    const midX = (startX + endX) / 2;
    const distance = Math.abs(endX - startX);
    const droopAmount = Math.min(distance * 0.3, 50);
    const midY = Math.max(startY, endY) + droopAmount;
    
    return `M ${startX} ${startY} Q ${midX} ${midY} ${endX} ${endY}`;
  };

  // Handle mouse/touch events for dragging
  const handleOscMouseDown = (oscIndex, e) => {
    e.preventDefault();
    const svgRect = svgRef.current.getBoundingClientRect();
    setDragging({
      oscIndex,
      mousePos: {
        x: e.clientX - svgRect.left,
        y: e.clientY - svgRect.top
      }
    });
  };

  const handleMouseMove = useCallback((e) => {
    if (!dragging || !svgRef.current) return;
    
    const svgRect = svgRef.current.getBoundingClientRect();
    setDragging(prev => ({
      ...prev,
      mousePos: {
        x: e.clientX - svgRect.left,
        y: e.clientY - svgRect.top
      }
    }));
  }, [dragging]);

  const handleMouseUp = useCallback((e) => {
    if (!dragging || !svgRef.current) return;
    
    const svgRect = svgRef.current.getBoundingClientRect();
    const mouseX = e.clientX - svgRect.left;
    const mouseY = e.clientY - svgRect.top;
    
    // Check if mouse is over an output node
    const hitRadius = 20;
    for (let i = 0; i < nodePositions.out.length; i++) {
      const out = nodePositions.out[i];
      const dist = Math.sqrt((mouseX - out.x) ** 2 + (mouseY - out.y) ** 2);
      if (dist < hitRadius) {
        onRoutingChange('add', dragging.oscIndex, i);
        break;
      }
    }
    
    setDragging(null);
  }, [dragging, nodePositions.out, onRoutingChange]);

  useEffect(() => {
    if (dragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [dragging, handleMouseMove, handleMouseUp]);

  // Handle clicking on existing cable to remove it
  const handleCableClick = (oscIndex, outIndex) => {
    onRoutingChange('remove', oscIndex, outIndex);
  };
  
  // Handle clicking on output to clear all cables going to it
  const handleOutputClick = (outIndex) => {
    onRoutingChange('clearOutput', null, outIndex);
  };

  return (
    <div className="patch-bay-container" style={{ maxHeight: '300px', overflowY: 'auto' }}>
      <svg 
        ref={svgRef} 
        className="patch-bay-svg"
        style={{ height: `${dynamicHeight}px`, minHeight: `${dynamicHeight}px` }}
      >
        {/* Existing cables - now handles array of outputs per oscillator */}
        {Object.entries(routingMap).flatMap(([oscIndex, outputs]) => {
          const oscIdx = parseInt(oscIndex);
          if (oscIdx >= nodePositions.osc.length) return [];
          
          // Handle both array and single value (for backwards compat)
          const outputList = Array.isArray(outputs) ? outputs : [outputs];
          
          return outputList.map(outIndex => {
            if (outIndex === null || outIndex === undefined) return null;
            if (outIndex >= nodePositions.out.length) return null;
            
            const start = nodePositions.osc[oscIdx];
            const end = nodePositions.out[outIndex];
            if (!start || !end) return null;
            
            return (
              <g key={`cable-${oscIndex}-${outIndex}`} className="cable-group">
                {/* Cable shadow for glow effect */}
                <path
                  d={getCablePath(start.x, start.y, end.x, end.y)}
                  className="cable-shadow"
                  stroke={getOscColor(oscIdx)}
                  strokeWidth="8"
                  fill="none"
                  opacity="0.3"
                />
                {/* Main cable */}
                <path
                  d={getCablePath(start.x, start.y, end.x, end.y)}
                  className="cable"
                  stroke={getOscColor(oscIdx)}
                  strokeWidth="4"
                  fill="none"
                  onClick={() => handleCableClick(oscIdx, outIndex)}
                />
              </g>
            );
          });
        })}
        
        {/* Dragging cable preview */}
        {dragging && nodePositions.osc[dragging.oscIndex] && (
          <path
            d={getCablePath(
              nodePositions.osc[dragging.oscIndex].x,
              nodePositions.osc[dragging.oscIndex].y,
              dragging.mousePos.x,
              dragging.mousePos.y
            )}
            className="cable-preview"
            stroke={getOscColor(dragging.oscIndex)}
            strokeWidth="3"
            strokeDasharray="5,5"
            fill="none"
            opacity="0.7"
          />
        )}
        
        {/* Oscillator nodes (left side) */}
        {nodePositions.osc.map((pos, i) => {
          if (!pos) return null;
          return (
            <g key={`osc-${i}`} className="node-group">
              <circle
                cx={pos.x}
                cy={pos.y}
                r="12"
                className="node osc-node"
                fill={getOscColor(i)}
                onMouseDown={(e) => handleOscMouseDown(i, e)}
              />
              <text
                x={pos.x}
                y={pos.y}
                className="node-label"
                textAnchor="middle"
                dominantBaseline="central"
              >
                {i + 1}
              </text>
            </g>
          );
        })}
        
        {/* Output nodes (right side) - squares */}
        {nodePositions.out.map((pos, i) => {
          if (!pos) return null;
          // For stereo (2 channels), show L/R. For more, show numbers
          const label = outputChannels === 2 
            ? (i === 0 ? 'L' : 'R')
            : String(i + 1);
          const size = 20;
          return (
            <g key={`out-${i}`} className="node-group">
              <rect
                x={pos.x - size / 2}
                y={pos.y - size / 2}
                width={size}
                height={size}
                rx="3"
                className="node out-node"
                fill="#666"
                onClick={() => handleOutputClick(i)}
                style={{ cursor: 'pointer' }}
              />
              <text
                x={pos.x}
                y={pos.y}
                className="node-label"
                textAnchor="middle"
                dominantBaseline="central"
                style={{ pointerEvents: 'none' }}
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
      
      {/* Labels */}
      <div className="patch-bay-labels">
        <span className="label-left">Oscillators</span>
        <span className="label-right">Outputs ({outputChannels}ch)</span>
      </div>
    </div>
  );
}
