// ─────────────────────────────────────────────────────────────────────────
// HANNIBAL · NEURAL CORE — locked idle visuals.
// Visuals are frozen. Only the mount/sizing is parameterized so the brain can
// live inside a sized container (the command-center center stage) instead of
// filling the window. Do not change shaders / geometry / CFG.
// ─────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export function initNeuralBrain(canvas) {
  // CONFIG — locked
  const CFG = {
    count:        300,     // particle nodes
    color:        0x00E5FF, // electric cyan
    bg:           0x06060C, // near-black blue
    particleSize: 0.16,    // base world-space glow diameter (scaled per tier)
    linkDist:     0.52,    // max distance to draw a connection
    linkMax:      6,       // max connections per node (keeps it clean)
    linkWidth:    2.4,     // line thickness in pixels (real fat lines)
    linkBright:   0.85,    // overall line brightness (additive)
    linkRadius:   1.7,     // lines fade to invisible past this distance from orb
    breatheAmp:   0.02,    // scale pulse: 0.98 .. 1.02
    breathePeriod: 4.0,    // seconds per breath
    rotateSpeed:  0.08,    // radians/sec — very slow Y float (~78s/rev)
    fireRate:     2.5,     // random neuron firings per second
  };

  const sizeOf = () => ({
    w: canvas.clientWidth  || canvas.parentElement.clientWidth,
    h: canvas.clientHeight || canvas.parentElement.clientHeight,
  });

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  let { w, h } = sizeOf();
  renderer.setSize(w, h, false);
  renderer.setClearColor(CFG.bg, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
  camera.position.set(0, 0.25, 3.35); // closer dolly → brain fills more of the center stage

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 2.5;
  controls.maxDistance = 9;
  controls.enablePan = false;
  // Brain spins itself on Y (a floating drift); OrbitControls is just for inspection.

  const brain = new THREE.Group();
  scene.add(brain);

  // ── BRAIN-SHAPED POINT CLOUD ──
  function noise3(x, y, z) {
    return (
      Math.sin(x * 1.0 + y * 1.7 + z * 0.3) +
      Math.sin(y * 1.3 + z * 1.9 + x * 0.5) +
      Math.sin(z * 1.1 + x * 2.1 + y * 0.7)
    ) / 3.0;
  }

  function generateBrainPoints(count) {
    const pts = [];
    const ax = 1.15, ay = 0.95, az = 1.45; // width, height, length(front-back)
    while (pts.length < count) {
      const u = Math.random(), v = Math.random();
      const theta = Math.acos(2 * v - 1);
      const phi = 2 * Math.PI * u;
      let r = 0.62 + 0.38 * Math.pow(Math.random(), 0.4);

      let x = r * Math.sin(theta) * Math.cos(phi);
      let y = r * Math.cos(theta);
      let z = r * Math.sin(theta) * Math.sin(phi);

      const disp = 1.0 + 0.13 * noise3(x * 3.0, y * 3.0, z * 3.0);
      x *= disp; y *= disp; z *= disp;

      x *= ax; y *= ay; z *= az;

      if (Math.abs(x) < 0.13 && y > -0.15) {
        x += (x >= 0 ? 1 : -1) * 0.13;
        y -= 0.07;
      }

      pts.push(new THREE.Vector3(x, y, z));
    }
    return pts;
  }

  const points = generateBrainPoints(CFG.count);

  // ── PARTICLES — InstancedMesh of camera-facing quads + glow shader ──
  const particleGeo = new THREE.PlaneGeometry(1, 1);

  const seeds  = new Float32Array(CFG.count);
  const scales = new Float32Array(CFG.count);
  const brights = new Float32Array(CFG.count);
  const fires  = new Float32Array(CFG.count).fill(-100);
  for (let i = 0; i < CFG.count; i++) {
    seeds[i] = Math.random() * 100;
    const tier = Math.random();
    if (tier < 0.20) {
      scales[i]  = 1.5 + Math.random() * 0.5;
      brights[i] = 1.25 + Math.random() * 0.25;
    } else if (tier < 0.70) {
      scales[i]  = 0.85 + Math.random() * 0.35;
      brights[i] = 0.8 + Math.random() * 0.2;
    } else {
      scales[i]  = 0.45 + Math.random() * 0.25;
      brights[i] = 0.4 + Math.random() * 0.18;
    }
  }
  particleGeo.setAttribute('aSeed',   new THREE.InstancedBufferAttribute(seeds, 1));
  particleGeo.setAttribute('aScale',  new THREE.InstancedBufferAttribute(scales, 1));
  particleGeo.setAttribute('aBright', new THREE.InstancedBufferAttribute(brights, 1));
  const fireAttr = new THREE.InstancedBufferAttribute(fires, 1);
  fireAttr.setUsage(THREE.DynamicDrawUsage);
  particleGeo.setAttribute('aFire', fireAttr);

  const particleMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:  { value: 0 },
      uSize:  { value: CFG.particleSize },
      uColor: { value: new THREE.Color(CFG.color) },
      uGold:  { value: new THREE.Color(0xD4A24C) },
      // state weights (0..1, smoothly lerped on the JS side). All zero == idle,
      // which makes the idle path byte-identical to the locked visuals.
      uListen:    { value: 0 },
      uThink:     { value: 0 },
      uSpeak:     { value: 0 },
      uVision:    { value: 0 },
      uStateTime: { value: 0 },
      uAmplitude: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute float aSeed;
      attribute float aScale;
      attribute float aBright;
      attribute float aFire;
      uniform float uTime;
      uniform float uSize;
      uniform float uListen;
      uniform float uThink;
      uniform float uSpeak;
      uniform float uVision;
      uniform float uStateTime;
      uniform float uAmplitude;
      varying vec2 vUv;
      varying float vBright;
      varying float vGold;
      void main() {
        vUv = uv;
        // ── IDLE baseline (unchanged) ──
        float twinkle = 0.85 + 0.15 * sin(uTime * (0.8 + aSeed * 0.06) + aSeed * 6.28);
        float base = aBright * twinkle;

        float since = uTime - aFire;
        float fire = (since >= 0.0) ? exp(-since * 5.0) : 0.0;
        float bright = base + fire * 2.2;

        vec4 center = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec4 mv = modelViewMatrix * center;

        float depth = -mv.z;
        float fade = smoothstep(6.8, 2.0, depth);

        float swell = 1.0 + fire * 0.6;

        // ── STATE EFFECTS (brain-local position) ──
        vec3 c = center.xyz;
        float radius = length(c);

        // LISTENING — left side (x<0) pulses brighter & faster
        float leftMask = smoothstep(0.0, -0.65, c.x);
        float listenPulse = 0.5 + 0.5 * sin(uTime * 5.0 + radius * 2.5);
        float listenBoost = uListen * leftMask * listenPulse * 1.8;

        // THINKING — expanding shells cascading from center, accelerating
        float tSpeed = 0.30 + uStateTime * 0.12;
        float front  = fract(uStateTime * tSpeed)       * 2.4;
        float front2 = fract(uStateTime * tSpeed + 0.5) * 2.4;
        float shell  = exp(-pow((radius - front)  * 4.0, 2.0));
        float shell2 = exp(-pow((radius - front2) * 4.0, 2.0));
        float thinkBoost = uThink * (shell + shell2) * 2.6;

        // SPEAKING — smooth wave outward from orb, amplitude-synced
        float wave = 0.5 + 0.5 * sin(radius * 3.5 - uTime * 6.0);
        float speakBoost = uSpeak * wave * (0.6 + uAmplitude * 1.8);

        // VISION — right cluster turns gold
        float rightMask = smoothstep(0.3, 0.95, c.x);
        vGold = uVision * rightMask;
        float visionBoost = uVision * rightMask * 1.3;

        float stateBoost = listenBoost + thinkBoost + speakBoost + visionBoost;
        vBright = bright * fade + stateBoost * fade;
        swell += thinkBoost * 0.12 + listenBoost * 0.05 + speakBoost * 0.05;

        mv.xy += position.xy * uSize * aScale * swell;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform vec3 uGold;
      varying vec2 vUv;
      varying float vBright;
      varying float vGold;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        if (d > 1.0) discard;
        float halo = pow(smoothstep(1.0, 0.0, d), 2.2);
        float core = smoothstep(0.32, 0.0, d);
        float intensity = (halo * 0.55 + core) * vBright;
        vec3 tint = mix(uColor, uGold, clamp(vGold, 0.0, 1.0));
        vec3 col = tint * intensity + vec3(1.0) * core * vBright * 0.25;
        gl_FragColor = vec4(col, intensity);
      }
    `,
  });

  const particles = new THREE.InstancedMesh(particleGeo, particleMat, CFG.count);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < CFG.count; i++) {
    dummy.position.copy(points[i]);
    dummy.updateMatrix();
    particles.setMatrixAt(i, dummy.matrix);
  }
  particles.instanceMatrix.needsUpdate = true;
  brain.add(particles);

  // ── CONNECTIONS — fat lines, center-weighted opacity baked into color ──
  const smoothstep = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const cyan = new THREE.Color(CFG.color);

  function buildConnections(pts) {
    const positions = [];
    const colors = [];
    const degree = new Array(pts.length).fill(0);
    const seen = new Set();

    const pushVertex = (p, dist) => {
      const closeness = 0.5 + 0.5 * (1.0 - dist / CFG.linkDist);
      let centerFade = smoothstep(CFG.linkRadius, 0.0, p.length());
      centerFade = Math.pow(centerFade, 1.6);
      const intensity = Math.min(1, closeness * centerFade) * CFG.linkBright;
      positions.push(p.x, p.y, p.z);
      colors.push(cyan.r * intensity, cyan.g * intensity, cyan.b * intensity);
    };

    for (let i = 0; i < pts.length; i++) {
      const near = [];
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        const dist = pts[i].distanceTo(pts[j]);
        if (dist < CFG.linkDist) near.push({ j, dist });
      }
      near.sort((a, b) => a.dist - b.dist);

      for (const { j, dist } of near) {
        if (degree[i] >= CFG.linkMax) break;
        if (degree[j] >= CFG.linkMax) continue;
        const key = i < j ? `${i}_${j}` : `${j}_${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        degree[i]++; degree[j]++;
        pushVertex(pts[i], dist);
        pushVertex(pts[j], dist);
      }
    }
    return { positions, colors, count: seen.size };
  }

  const conn = buildConnections(points);
  const lineGeo = new LineSegmentsGeometry();
  lineGeo.setPositions(conn.positions);
  lineGeo.setColors(conn.colors);

  const lineMat = new LineMaterial({
    vertexColors: true,
    linewidth: CFG.linkWidth,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    dashed: false,
  });
  lineMat.resolution.set(w, h);

  const lines = new LineSegments2(lineGeo, lineMat);
  lines.computeLineDistances();
  brain.add(lines);

  // ── VOICE ORB — glowing core + tight halo + soft outer light-bleed ──
  const orb = new THREE.Group();

  const orbCore = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.28, 5),
    new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(CFG.color) } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uTime;
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          float fres = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.0);
          float pulse = 0.85 + 0.15 * sin(uTime * 1.6);
          float intensity = (0.35 + fres * 1.3) * pulse;
          vec3 col = uColor * intensity + vec3(1.0) * fres * 0.4;
          gl_FragColor = vec4(col, intensity);
        }
      `,
    })
  );
  orb.add(orbCore);

  const orbHalo = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 1.6),
    new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(CFG.color) } },
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          float pulse = 1.0 + 0.06 * sin(uTime * 1.6);
          vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          mv.xy += position.xy * pulse;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float glow = pow(smoothstep(1.0, 0.0, d), 3.0);
          float pulse = 0.8 + 0.2 * sin(uTime * 1.6);
          gl_FragColor = vec4(uColor * glow * pulse, glow * pulse * 0.7);
        }
      `,
    })
  );
  orb.add(orbHalo);

  const orbGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(4.0, 4.0),
    new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(CFG.color) } },
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          float breathe = 1.0 + 0.05 * sin(uTime * 1.6);
          vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          mv.xy += position.xy * breathe;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float glow = smoothstep(1.0, 0.0, d);
          glow = glow * glow;
          float pulse = 0.85 + 0.15 * sin(uTime * 1.6);
          float a = glow * pulse * 0.22;
          gl_FragColor = vec4(uColor * a, a);
        }
      `,
    })
  );
  orb.add(orbGlow);
  brain.add(orb);

  // optional HUD hooks (no-op if elements absent)
  const nodeEl = document.getElementById('nodeCount');
  const linkEl = document.getElementById('linkCount');
  if (nodeEl) nodeEl.textContent = String(CFG.count);
  if (linkEl) linkEl.textContent = String(conn.count);

  // ── STATE MACHINE ──
  const STATES = ['idle', 'listening', 'thinking', 'speaking', 'vision'];
  let currentState = 'idle';
  let stateTime = 0;        // seconds since the current state began
  let amplitude = 0;        // 0..1, for speaking (wired to audio later)
  const weights = { listening: 0, thinking: 0, speaking: 0, vision: 0 };

  function setState(state) {
    if (!STATES.includes(state) || state === currentState) return;
    currentState = state;
    stateTime = 0;
  }
  function setAmplitude(v) {
    amplitude = Math.max(0, Math.min(1, Number(v) || 0));
  }
  // Fire a burst of neuron activations — a visible cascade. The agent loop calls
  // this once per executed step so "thinking → acting" lights up in sequence.
  function pulse(count = 40) {
    const t = clock.elapsedTime;
    const n = Math.max(1, count | 0);
    for (let i = 0; i < n; i++) fires[(Math.random() * CFG.count) | 0] = t;
    fireAttr.needsUpdate = true;
  }

  // ── ANIMATION LOOP ──
  const clock = new THREE.Clock();
  let fireAccum = 0;
  let breathePhase = 0;
  const baseFreq = (Math.PI * 2.0) / CFG.breathePeriod;
  const lerp = (a, b, k) => a + (b - a) * k;

  function tick() {
    const dt = clock.getDelta();
    const t = clock.elapsedTime;
    stateTime += dt;

    // smooth, frame-rate-independent crossfade of state weights
    const k = 1 - Math.pow(0.001, dt);
    for (const key of Object.keys(weights)) {
      weights[key] = lerp(weights[key], currentState === key ? 1 : 0, k);
    }

    particleMat.uniforms.uTime.value = t;
    particleMat.uniforms.uListen.value = weights.listening;
    particleMat.uniforms.uThink.value = weights.thinking;
    particleMat.uniforms.uSpeak.value = weights.speaking;
    particleMat.uniforms.uVision.value = weights.vision;
    particleMat.uniforms.uStateTime.value = stateTime;
    particleMat.uniforms.uAmplitude.value = amplitude;
    orbCore.material.uniforms.uTime.value = t;
    orbHalo.material.uniforms.uTime.value = t;
    orbGlow.material.uniforms.uTime.value = t;

    // breathing — faster while listening, a touch deeper while listening/speaking
    const freqMul = 1 + weights.listening * 1.4 + weights.thinking * 0.8;
    const ampMul  = 1 + weights.listening * 0.6 + weights.speaking * 0.3;
    breathePhase += dt * baseFreq * freqMul;
    brain.scale.setScalar(1.0 + CFG.breatheAmp * ampMul * Math.sin(breathePhase));

    // rotation — slightly faster while thinking
    brain.rotation.y += dt * CFG.rotateSpeed * (1 + weights.thinking * 0.6);

    fireAccum += dt * CFG.fireRate;
    while (fireAccum >= 1.0) {
      const idx = (Math.random() * CFG.count) | 0;
      fires[idx] = t;
      fireAttr.needsUpdate = true;
      fireAccum -= 1.0;
    }

    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  tick();

  // ── RESIZE — track the container, not the window ──
  function resize() {
    ({ w, h } = sizeOf());
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    lineMat.resolution.set(w, h);
  }
  if (window.ResizeObserver) {
    new ResizeObserver(resize).observe(canvas.parentElement || canvas);
  }
  window.addEventListener('resize', resize);

  return { setState, setAmplitude, pulse, resize, getState: () => currentState };
}
