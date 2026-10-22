import React, { useEffect, useRef, useState } from 'react';

/**
 * 跳跃橘猫 — 照抄 plan-c-minimal.html 的造型
 */
function JumpingCat() {
  const svgRef = useRef(null);
  const animRef = useRef(null);
  const mouseRef = useRef({ x: 0, y: 0, active: false, timer: null });
  const stateRef = useRef({
    phase: 'idle',
    phaseTime: 0,
    jumpIndex: 0,
    catX: 172,
    catY: 70,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    shadowScale: 1,
    shadowOpacity: 0.15,
    headRotation: 0,
    pupilX: 0,
    pupilY: 0,
    tailAngle: 0,
    tailSpeed: 1,
    lookDirection: 0,
    lookTimer: 0,
  });

  const [, setTick] = useState(0);

  // 容器位置（参考 plan-c-minimal.html 320x320 viewBox）
  const containerPositions = [
    { x: 172, y: 70 },
    { x: 142, y: 126 },
    { x: 202, y: 126 },
    { x: 112, y: 182 },
    { x: 172, y: 182 },
    { x: 232, y: 182 },
  ];

  useEffect(() => {
    const state = stateRef.current;
    let lastTime = performance.now();

    const animate = (now) => {
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      state.phaseTime += dt;

      // 尾巴摆动
      state.tailAngle += dt * 3 * state.tailSpeed;
      if (state.phase === 'jump') state.tailSpeed = 2.5;
      else state.tailSpeed = 1;

      // 鼠标跟踪（参考 plan-c-minimal.html 的方式）
      const mouse = mouseRef.current;
      if (mouse.active) {
        const parentSvg = svgRef.current?.ownerSVGElement || svgRef.current?.closest?.('svg');
        if (parentSvg) {
          const r = parentSvg.getBoundingClientRect();
          const s = r.width / 320;
          const hcx = r.left + state.catX * s;
          const hcy = r.top + (state.catY - 33) * s;
          const dx = mouse.x - hcx;
          const dy = mouse.y - hcy;
          state.headRotation = Math.max(-26, Math.min(26, Math.atan2(dx, Math.abs(dy) + 80) * 57.2958 * 0.62));
          state.pupilX = Math.max(-2.4, Math.min(2.4, dx / (30 / s)));
          state.pupilY = Math.max(-1.9, Math.min(1.9, dy / (36 / s)));
        }
      } else {
        state.lookTimer += dt;
        if (state.lookTimer > 2 + Math.random() * 2) {
          state.lookDirection = (Math.random() - 0.5) * 40;
          state.lookTimer = 0;
        }
        state.headRotation += (state.lookDirection - state.headRotation) * dt * 2;
        state.pupilX += (state.lookDirection * 0.1 - state.pupilX) * dt * 2;
        state.pupilY = 0;
      }

      // 状态机
      switch (state.phase) {
        case 'idle': {
          state.scaleX = 1; state.scaleY = 1; state.rotation = 0;
          state.shadowScale = 1; state.shadowOpacity = 0.15;
          if (!mouse.active && state.phaseTime > 10 + Math.random() * 6) {
            state.phase = 'squash'; state.phaseTime = 0;
          }
          break;
        }
        case 'squash': {
          const t = Math.min(state.phaseTime / 0.3, 1);
          const b = Math.sin(t * Math.PI);
          state.scaleX = 1 + 0.17 * b;
          state.scaleY = 1 - 0.19 * b;
          state.shadowScale = 1 + 0.2 * b;
          state.shadowOpacity = 0.15 + 0.1 * b;
          if (t >= 1) { state.phase = 'jump'; state.phaseTime = 0; }
          break;
        }
        case 'jump': {
          const from = containerPositions[state.jumpIndex % containerPositions.length];
          const toIndex = (state.jumpIndex + 1) % containerPositions.length;
          const to = containerPositions[toIndex];
          const duration = 0.8 + Math.abs(to.y - from.y) * 0.002;
          const t = Math.min(state.phaseTime / duration, 1);
          const easeT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          state.catX = from.x + (to.x - from.x) * easeT;
          const baseY = from.y + (to.y - from.y) * easeT;
          state.catY = baseY - 4 * 40 * t * (1 - t);
          const st = Math.sin(t * Math.PI);
          state.scaleY = 1 + 0.11 * st;
          state.scaleX = 1 - 0.07 * st;
          state.rotation = Math.max(-9, Math.min(9, (to.x - from.x) / 26)) * st;
          const liftRatio = Math.max(0, baseY - state.catY) / 54;
          state.shadowScale = 1 - 0.42 * liftRatio;
          state.shadowOpacity = 0.15 - 0.1 * liftRatio;
          if (t >= 1) {
            state.phase = 'land'; state.phaseTime = 0;
            state.jumpIndex = toIndex; state.catX = to.x; state.catY = to.y;
          }
          break;
        }
        case 'land': {
          const t = Math.min(state.phaseTime / 0.2, 1);
          const bb = Math.pow(1 - t, 2);
          state.scaleY = 1 - 0.2 * bb;
          state.scaleX = 1 + 0.17 * bb;
          state.rotation *= (1 - t);
          state.shadowScale = 0.58 + 0.42 * t;
          state.shadowOpacity = 0.05 + 0.1 * t;
          if (t >= 1) { state.phase = 'bounce'; state.phaseTime = 0; }
          break;
        }
        case 'bounce': {
          const t = Math.min(state.phaseTime / 0.3, 1);
          const b = Math.sin(t * Math.PI) * 0.1;
          state.scaleX = 1 - b * 0.5;
          state.scaleY = 1 + b;
          state.shadowScale = 1;
          state.shadowOpacity = 0.15;
          if (t >= 1) {
            state.phase = 'idle'; state.phaseTime = 0;
            state.scaleX = 1; state.scaleY = 1; state.rotation = 0;
          }
          break;
        }
      }

      setTick((v) => v + 1);
      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);
    const handleMouseMove = (e) => {
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;
      mouseRef.current.active = true;
      clearTimeout(mouseRef.current.timer);
      mouseRef.current.timer = setTimeout(() => { mouseRef.current.active = false; }, 2000);
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener('mousemove', handleMouseMove);
      clearTimeout(mouseRef.current.timer);
    };
  }, []);

  const s = stateRef.current;
  const tailWag = Math.sin(s.tailAngle) * (s.phase === 'jump' ? 13 : 7);

  return (
    <g ref={svgRef}>
      {/* 接触阴影 */}
      <ellipse
        cx={s.catX}
        cy={s.catY + 1.6}
        rx={13 * s.shadowScale}
        ry={3.4 * s.shadowScale}
        fill="#111"
        opacity={s.shadowOpacity}
      />

      {/* 猫 */}
      <g transform={`translate(${s.catX},${s.catY}) rotate(${s.rotation},0,-18) scale(${s.scaleX},${s.scaleY})`}>

        {/* 尾巴 */}
        <g transform={`rotate(${tailWag},9,-9)`}>
          <path d="M9 -9 C 21 -11, 26 -20, 21 -30"
            stroke="#E8913F" strokeWidth="5.6" fill="none" strokeLinecap="round" />
          <path d="M23.4 -19.5 C 24.6 -22, 23.8 -24.6, 22.2 -26.6"
            stroke="#CE7530" strokeWidth="5.6" fill="none" strokeLinecap="round" opacity="0.85" />
        </g>

        {/* 身体 */}
        <path d="M0 -29 C 12.5 -29 15.5 -19 15.5 -11.5 C 15.5 -3 9.5 1 0 1 C -9.5 1 -15.5 -3 -15.5 -11.5 C -15.5 -19 -12.5 -29 0 -29 Z"
          fill="#F2A15C" />
        {/* 身体斑纹 */}
        <path d="M-11 -20 C -11 -24 -7 -26 -3 -25" stroke="#DE8542" strokeWidth="2.2" strokeLinecap="round" opacity="0.75" />
        <path d="M11 -20 C 11 -24 7 -26 3 -25" stroke="#DE8542" strokeWidth="2.2" strokeLinecap="round" opacity="0.75" />
        {/* 胸口浅色 */}
        <ellipse cx="0" cy="-7" rx="7.2" ry="7.4" fill="#FFF4E6" />
        {/* 前爪 */}
        <ellipse cx="-6.2" cy="-1.2" rx="4" ry="2.5" fill="#FFF4E6" />
        <ellipse cx="6.2" cy="-1.2" rx="4" ry="2.5" fill="#FFF4E6" />

        {/* 头 */}
        <g transform={`rotate(${s.headRotation},0,-22)`}>
          {/* 耳朵 */}
          <path d="M-11.6 -40.5 L -8.6 -51 L -2 -43.6 Z" fill="#F2A15C" />
          <path d="M11.6 -40.5 L 8.6 -51 L 2 -43.6 Z" fill="#F2A15C" />
          <path d="M-9.8 -42.4 L -8.4 -47.6 L -4.6 -43.6 Z" fill="#F9C7A5" />
          <path d="M9.8 -42.4 L 8.4 -47.6 L 4.6 -43.6 Z" fill="#F9C7A5" />

          {/* 头 */}
          <circle cx="0" cy="-33" r="12.2" fill="#F2A15C" />

          {/* 额头条纹 */}
          <g stroke="#DE8542" strokeWidth="1.8" strokeLinecap="round" opacity="0.9">
            <path d="M-4.2 -43.2 L -3.2 -38.6" />
            <path d="M0 -44 L 0 -38.8" />
            <path d="M4.2 -43.2 L 3.2 -38.6" />
          </g>

          {/* 口鼻 */}
          <ellipse cx="0" cy="-27.6" rx="7.4" ry="5.2" fill="#FFF4E6" />

          {/* 眼睛 */}
          <g transform={`translate(${s.pupilX},${s.pupilY})`}>
            <ellipse cx="-5.2" cy="-34.6" rx="2.4" ry="3" fill="#2A1B12" />
            <ellipse cx="5.2" cy="-34.6" rx="2.4" ry="3" fill="#2A1B12" />
            <circle cx="-4.5" cy="-35.9" r="0.9" fill="#fff" />
            <circle cx="5.9" cy="-35.9" r="0.9" fill="#fff" />
          </g>

          {/* 鼻子 */}
          <path d="M0 -30.1 l-1.7 -1.6 h3.4 Z" fill="#E88C93" />
          {/* 嘴 */}
          <path d="M-2.2 -27.9 q2.2 1.9 4.4 0" stroke="#C4805A" strokeWidth="0.9" fill="none" strokeLinecap="round" />

          {/* 胡须 */}
          <g stroke="#E8C3A2" strokeWidth="0.9" strokeLinecap="round">
            <path d="M-7.2 -28.8 l-6.2 -1.6 M-7.2 -27.2 l-6.2 1" />
            <path d="M7.2 -28.8 l6.2 -1.6 M7.2 -27.2 l6.2 1" />
          </g>
        </g>
      </g>
    </g>
  );
}

export default JumpingCat;
