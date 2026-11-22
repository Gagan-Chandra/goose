// Procedural cat: every part is recomputed each frame from a few pose values
// (walk phase, sit, loaf, arch, crouch...) so motion stays fluid and blends
// between poses instead of snapping between canned animations.
// Faces right in local coordinates; ground is y = 112 in a 160x120 box.

(() => {
  const NS = "http://www.w3.org/2000/svg";
  const COLORS = {
    fur: "#f5a863", far: "#dd8a48", stripe: "#d0742f", cream: "#fff3e2",
    line: "#3b2a20", pink: "#f6aaa3", nose: "#e27f86", eye: "#2a221d", tongue: "#f07f8e",
  };
  const GROUND = 112;
  const TAIL_SEGMENTS = 9;
  const TAIL_SEG_LEN = 5.6;

  const lerp = (a, b, t) => a + (b - a) * t;
  const lerp2 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
  const ease = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
  const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Two-bone IK: returns the knee for a leg from joint j to paw p.
  // bend = +1 puts the knee toward the tail, like a cat's elbow and hock.
  function ik(j, p, l1, l2, bend = 1) {
    let dx = p[0] - j[0], dy = p[1] - j[1];
    let d = Math.hypot(dx, dy) || 0.001;
    const max = l1 + l2 - 0.01;
    if (d > max) { p = [j[0] + (dx / d) * max, j[1] + (dy / d) * max]; dx = p[0] - j[0]; dy = p[1] - j[1]; d = max; }
    const a = Math.atan2(dy, dx) + bend * Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
    return { knee: [j[0] + Math.cos(a) * l1, j[1] + Math.sin(a) * l1], paw: p };
  }

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  const BASE = {
    sit: 0, loaf: 0, arch: 0, puff: 0, earsBack: 0, angry: 0, eyesClosed: 0, tailUp: 0,
    bow: 0, crouch: 0, groom: 0, yawn: 0, wide: 0,
  };
  const POSES = Object.fromEntries(Object.entries({
    stand: {},
    sit: { sit: 1 },
    sleep: { loaf: 1, earsBack: 0.2, eyesClosed: 1 },
    alert: { puff: 0.3, tailUp: 1, wide: 1 },
    grumpy: { arch: 0.25, puff: 0.4, earsBack: 0.6, angry: 1, tailUp: 0.6 },
    hiss: { arch: 1, puff: 1, earsBack: 1, angry: 1, tailUp: 1 },
    happy: { sit: 1, eyesClosed: 1 },
    crouch: { crouch: 1, wide: 1 },
    stretch: { bow: 1, eyesClosed: 0.8 },
    groom: { sit: 1, groom: 1, eyesClosed: 0.8 },
    yawn: { sit: 1, yawn: 1, eyesClosed: 1, earsBack: 0.3 },
    dangle: { wide: 1, earsBack: 0.35, puff: 0.2 },
  }).map(([k, v]) => [k, { ...BASE, ...v }]));
  const FAST_KEYS = new Set(["puff", "earsBack", "crouch", "wide"]);

  class Cat {
    constructor(host) {
      const svg = (this.svg = el("svg", { viewBox: "0 0 160 120" }, host));
      const clip = el("clipPath", { id: "cat-body-clip" }, el("defs", {}, svg));
      this.clipPath = el("path", {}, clip);

      this.shadow = el("ellipse", { ry: 4, fill: "rgba(0,0,0,.17)" }, svg);

      const tail = el("g", {}, svg);
      this.tailOutline = el("path", { fill: "none", stroke: COLORS.line, "stroke-linecap": "round", "stroke-linejoin": "round" }, tail);
      this.tailFill = el("path", { fill: "none", stroke: COLORS.fur, "stroke-linecap": "round", "stroke-linejoin": "round" }, tail);
      this.tailTip = el("path", { fill: "none", stroke: COLORS.stripe, "stroke-linecap": "round" }, tail);

      const makeLeg = (parent, color, width) => {
        const g = el("g", {}, parent);
        const line = { fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
        return {
          g,
          outline: el("path", { ...line, stroke: COLORS.line, "stroke-width": width + 3.5 }, g),
          fill: el("path", { ...line, stroke: color, "stroke-width": width }, g),
          paw: el("ellipse", { rx: 5.2, ry: 3.4, fill: COLORS.cream, stroke: COLORS.line, "stroke-width": 1.6 }, g),
        };
      };
      const farLegs = el("g", {}, svg);
      this.legs = { farBack: makeLeg(farLegs, COLORS.far, 7.5), farFront: makeLeg(farLegs, COLORS.far, 7) };

      this.bodyGroup = el("g", {}, svg);
      this.body = el("path", { fill: COLORS.fur, stroke: COLORS.line, "stroke-width": 2.6, "stroke-linejoin": "round" }, this.bodyGroup);
      const clipped = el("g", { "clip-path": "url(#cat-body-clip)" }, this.bodyGroup);
      this.belly = el("ellipse", { cx: 14, cy: 15, rx: 20, ry: 10, fill: COLORS.cream }, clipped);
      this.stripes = el("path", { fill: "none", stroke: COLORS.stripe, "stroke-width": 3.2, "stroke-linecap": "round" }, clipped);
      // Redraw the outline over the clipped fills so it stays crisp.
      this.bodyLine = el("path", { fill: "none", stroke: COLORS.line, "stroke-width": 2.6, "stroke-linejoin": "round" }, this.bodyGroup);

      const nearLegs = el("g", {}, svg);
      this.legs.nearBack = makeLeg(nearLegs, COLORS.fur, 7.5);

      this.haunch = el("g", {}, svg);
      el("ellipse", { cx: 0, cy: 0, rx: 17, ry: 15, fill: COLORS.fur, stroke: COLORS.line, "stroke-width": 2.6 }, this.haunch);
      el("path", { d: "M-6 -9 Q2 -4 0 6 M4 -12 Q11 -6 9 3", fill: "none", stroke: COLORS.stripe, "stroke-width": 3, "stroke-linecap": "round" }, this.haunch);

      this.buildHead(svg);
      // The near front leg goes over the head so a grooming paw reaches the mouth.
      this.legs.nearFront = makeLeg(el("g", {}, svg), COLORS.fur, 7);

      this.s = {
        t: 0, phase: 0, stride: 0,
        ...POSES.stand,
        a0: -2.2, curl: 0.13, sway: 0.08, swayFreq: 1.6,
        blinkAt: 2, blink: 0, twitchAt: 3, twitch: 0,
        lookX: 0, lookY: 0, tilt: 0, mouth: 0, dizzy: 0,
      };
      this.pose = "stand";
      this.dizzy = false;
      this.action = null;
      this.mouthUntil = 0;
      this.tiltTarget = 0;
    }

    buildHead(svg) {
      const head = (this.head = el("g", {}, svg));
      const ear = (x) => {
        const g = el("g", {}, head);
        el("path", { d: "M-8.5 3 L-2.2 -16.5 Q0 -20 2.4 -16.5 L9 3 Z", fill: COLORS.fur, stroke: COLORS.line, "stroke-width": 2.4, "stroke-linejoin": "round" }, g);
        el("path", { d: "M-4.5 1 L-0.8 -11 L4.8 1 Z", fill: COLORS.pink }, g);
        return { g, x };
      };
      this.earFar = ear(-10);
      this.earNear = ear(10);

      el("ellipse", { cx: 0, cy: 0, rx: 21.5, ry: 18, fill: COLORS.fur, stroke: COLORS.line, "stroke-width": 2.6 }, head);
      // Cheek fluff
      el("path", { d: "M-20 5 L-25 8 L-19.5 9.5 M20 5 L25 8 L19.5 9.5", fill: COLORS.fur, stroke: COLORS.line, "stroke-width": 2, "stroke-linejoin": "round" }, head);
      el("path", { d: "M-19 4 L-19 10 M19 4 L19 10", stroke: COLORS.fur, "stroke-width": 3 }, head);
      // Tabby "M" on the forehead
      el("path", { d: "M-6 -15 L-5 -9 M0 -17 L0 -10 M6 -15 L5 -9", stroke: COLORS.stripe, "stroke-width": 2.6, "stroke-linecap": "round" }, head);

      el("ellipse", { cx: 1, cy: 8.5, rx: 8.5, ry: 6, fill: COLORS.cream }, head);
      this.blush = [
        el("ellipse", { cx: -12.5, cy: 7, rx: 3.6, ry: 2.1, fill: COLORS.pink, opacity: 0.6 }, head),
        el("ellipse", { cx: 14.5, cy: 7, rx: 3.6, ry: 2.1, fill: COLORS.pink, opacity: 0.6 }, head),
      ];

      this.eyes = [-7.5, 9.5].map((cx) => {
        const g = el("g", { transform: `translate(${cx} 0)` }, head);
        const open = el("g", {}, g);
        el("ellipse", { cx: 0, cy: 0, rx: 4.3, ry: 5.2, fill: COLORS.eye }, open);
        el("circle", { cx: 1.4, cy: -1.9, r: 1.8, fill: "#fff" }, open);
        el("circle", { cx: -1.3, cy: 1.8, r: 0.85, fill: "#fff" }, open);
        const closed = el("path", { d: "M-4.2 0.5 Q0 3.8 4.2 0.5", fill: "none", stroke: COLORS.line, "stroke-width": 2, "stroke-linecap": "round" }, g);
        const inner = cx < 0 ? 1 : -1; // brows slope down toward the nose
        const brow = el("path", { d: `M${-4.5 * inner} -7.5 L${4 * inner} -5`, fill: "none", stroke: COLORS.line, "stroke-width": 2.2, "stroke-linecap": "round" }, g);
        const spiral = el("path", {
          d: "M0 0 a0.7 0.7 0 1 1 1.4 0 a2 2 0 1 1 -4 0 a3.3 3.3 0 1 1 6.6 0 a4.4 4.4 0 1 1 -8.8 0",
          fill: "none", stroke: COLORS.line, "stroke-width": 1.5, "stroke-linecap": "round", opacity: 0,
        }, g);
        return { open, closed, brow, spiral };
      });

      el("path", { d: "M-2 4.6 L4 4.6 L1 7.4 Z", fill: COLORS.nose, stroke: COLORS.nose, "stroke-width": 1.6, "stroke-linejoin": "round" }, head);
      this.mouthOpen = el("ellipse", { cx: 1, cy: 11.2, rx: 3, ry: 0, fill: "#7b2e33" }, head);
      this.tongue = el("ellipse", { cx: 2, cy: 12.6, rx: 2.3, ry: 0, fill: COLORS.tongue }, head);
      el("path", { d: "M-3.2 8.6 Q-1.1 11.2 1 8.6 Q3.1 11.2 5.2 8.6", fill: "none", stroke: COLORS.line, "stroke-width": 1.4, "stroke-linecap": "round" }, head);
      this.whiskers = el("path", { fill: "none", stroke: COLORS.line, "stroke-width": 0.9, opacity: 0.55, "stroke-linecap": "round" }, head);
      // Dizzy stars orbit above the head.
      this.stars = [0, 1, 2].map(() => el("path", {
        d: "M0 -4 L1.2 -1.2 L4 -1 L1.8 0.9 L2.5 3.8 L0 2.2 L-2.5 3.8 L-1.8 0.9 L-4 -1 L-1.2 -1.2 Z",
        fill: "#ffd23f", stroke: COLORS.line, "stroke-width": 1, "stroke-linejoin": "round", opacity: 0,
      }, head));
    }

    setPose(name) { if (POSES[name]) this.pose = name; }
    // A one-off action (groom, stretch, yawn...) that overrides the pose for a while.
    play(name, seconds) { if (POSES[name]) this.action = { name, until: this.s.t + seconds }; }
    get busy() { return !!this.action; }
    meow(seconds = 0.6) { this.mouthUntil = this.s.t + seconds; }
    tiltHead(deg) { this.tiltTarget = deg; }

    // look: where to look, in this SVG's local coordinates (null = straight ahead).
    // airborne: 0..1 mid-leap; hop: px the whole cat is lifted (keeps the shadow on the floor).
    update(dt, { moving = false, speed = 0, look = null, airborne = 0, hop = 0 } = {}) {
      const s = this.s;
      s.t += dt;
      if (this.action && s.t > this.action.until) this.action = null;
      const target = POSES[this.action ? this.action.name : this.pose];
      for (const k in target) s[k] = ease(s[k], target[k], FAST_KEYS.has(k) ? 12 : 6, dt);

      // --- gait: stride and cadence grow with speed ---
      const running = speed > 110;
      s.stride = ease(s.stride, moving ? Math.min(13, 5 + speed * 0.045) : 0, 10, dt);
      if (moving) s.phase += dt * (3.5 + Math.min(speed, 200) * 0.075);
      const lift = 3 + s.stride * 0.35;
      const bob = moving ? Math.abs(Math.sin(s.phase)) * (running ? 2.4 : 1.3) : 0;
      const breathe = Math.sin(s.t * 2.2) * 0.6 * (1 - s.stride / 13);
      s.dizzy = ease(s.dizzy, this.dizzy ? 1 : 0, 5, dt);
      // Running: the body stretches at full extension and bunches when the feet gather.
      const gallop = running ? Math.sin(s.phase * 2) * 0.06 * Math.min(1, (speed - 110) / 60) : 0;

      // --- skeleton: everything hangs off a hip pivot that tips back to sit ---
      const wiggle = Math.sin(s.t * 21) * s.crouch; // butt wiggle before a pounce
      const angle = -0.56 * s.sit + 0.3 * s.bow + 0.08 * s.crouch - 0.14 * airborne + wiggle * 0.025;
      const px = lerp(52, 56, s.sit) + wiggle * 1.6;
      const py = lerp(84 - s.arch * 6, GROUND - 16, s.sit) + s.loaf * 16 + s.crouch * 10 - s.bow * 5 - bob;
      const at = (ox, oy) => { const [x, y] = rot(ox, oy, angle); return [px + x, py + y]; };

      const [bx, by] = at(26, -12);
      const archLift = s.arch * 15;
      // Arching pulls the top controls inward and up, making a hump rather than a plateau.
      const cx = 36 - s.arch * 16, cy = -27 - archLift * 1.5;
      const bodyD = `M-36 0 C${-cx} ${cy} ${cx} ${cy + 4} 36 0 C36 ${26 - s.loaf * 4} -36 ${26 - s.loaf * 4} -36 0 Z`;
      const bodyT = `translate(${bx} ${by - breathe * 0.5}) rotate(${(angle * 180) / Math.PI}) scale(${1 + gallop} ${1 + breathe * 0.012 - gallop * 0.8})`;
      for (const p of [this.body, this.bodyLine, this.clipPath]) { p.setAttribute("d", bodyD); p.setAttribute("transform", bodyT); }
      this.belly.setAttribute("transform", bodyT);
      this.stripes.setAttribute("transform", bodyT);
      const sy = -20 - archLift * 1.05;
      this.stripes.setAttribute("d", `M-20 ${sy + 2} q3 7 0 13 M-8 ${sy - 1} q3 8 0 14 M4 ${sy - 1} q3 8 0 14 M16 ${sy + 1} q2 6 0 11`);

      // --- head ---
      s.tilt = ease(s.tilt, this.tiltTarget - s.angry * 6 + s.groom * 18 - s.yawn * 16 - s.bow * 6 + Math.sin(s.t * 5) * 12 * s.dizzy, 6, dt);
      const [nx, ny] = at(62, -36);
      const lick = Math.sin(s.t * 9);
      const headX = nx - s.loaf * 6 + s.arch * 4 + s.crouch * 5 - s.groom * 3;
      const headY = ny + s.loaf * 14 + s.arch * 6 + s.crouch * 2 + s.groom * (7 + lick * 1.6) + bob * 0.6 + Math.sin(s.t * 2.2) * 0.4;
      this.head.setAttribute("transform", `translate(${headX} ${headY}) rotate(${s.tilt})`);

      // --- legs: gait paw targets, solved with IK so knees bend naturally ---
      const segment = 15 + s.sit * 6;
      const shoulder = at(50, -2);
      const hip = at(4, -2);
      const legAlpha = 1 - s.loaf;
      const place = (j, off, extraX, airX) => {
        const ph = s.phase + off;
        let paw = [j[0] + Math.sin(ph) * s.stride + extraX, GROUND - 2 - Math.max(0, Math.cos(ph)) * lift * (s.stride / 13)];
        paw = lerp2(paw, [j[0] + airX, j[1] + segment * 1.75], airborne);
        return paw;
      };
      const draw = (L, j, paw, bend = 1) => {
        const { knee, paw: p } = ik(j, paw, segment, segment, bend);
        const d = `M${j[0]} ${j[1]} L${knee[0]} ${knee[1]} L${p[0]} ${p[1]}`;
        L.outline.setAttribute("d", d); L.fill.setAttribute("d", d);
        L.paw.setAttribute("cx", p[0] + 2); L.paw.setAttribute("cy", p[1] + 1);
        L.g.setAttribute("opacity", legAlpha);
      };
      const farShoulder = [shoulder[0] - 5, shoulder[1]], farHip = [hip[0] - 5, hip[1]];
      let nearFrontPaw = place(shoulder, 0, s.bow * 16, 16);
      // Grooming: bring the near front paw up to the mouth.
      nearFrontPaw = lerp2(nearFrontPaw, [headX - 3 + lick * 1.2, headY + 16], s.groom);
      draw(this.legs.nearFront, shoulder, nearFrontPaw);
      draw(this.legs.farFront, farShoulder, place(farShoulder, Math.PI, s.bow * 16 - 4, 12));
      draw(this.legs.nearBack, hip, place(hip, Math.PI, 6 * s.sit, -14));
      draw(this.legs.farBack, farHip, place(farHip, 0, 6 * s.sit - 4, -18));

      const [hx, hy] = at(4, -8);
      this.haunch.setAttribute("transform", `translate(${hx} ${hy}) rotate(${(angle * 180) / Math.PI})`);
      this.haunch.setAttribute("opacity", Math.max(0, s.sit - 0.15) * (1 - s.loaf));

      // Ears: flatten back when grumpy, flick now and then.
      if (s.t > s.twitchAt) { s.twitch = 1; s.twitchAt = s.t + 3 + Math.random() * 6; }
      s.twitch = ease(s.twitch, 0, 9, dt);
      const earFlat = 1 - s.earsBack * 0.25;
      this.earFar.g.setAttribute("transform", `translate(${this.earFar.x} -12) rotate(${-8 - s.earsBack * 50}) scale(1 ${earFlat})`);
      this.earNear.g.setAttribute("transform", `translate(${this.earNear.x} -12.5) rotate(${10 + s.earsBack * 50 + s.twitch * 18}) scale(1 ${earFlat})`);

      // Eyes: blink, follow the cursor, squint when angry, close when content.
      if (s.t > s.blinkAt) { s.blink = 1; s.blinkAt = s.t + 2.5 + Math.random() * 4; }
      s.blink = Math.max(0, s.blink - dt * 7);
      let lx = 0, ly = 0;
      if (look) {
        const dx = look[0] - headX, dy = look[1] - headY;
        const d = Math.hypot(dx, dy) || 1;
        lx = (dx / d) * Math.min(1.9, d / 30);
        ly = (dy / d) * Math.min(1.5, d / 30);
      }
      s.lookX = ease(s.lookX, lx, 10, dt);
      s.lookY = ease(s.lookY, ly, 10, dt);
      const openness = Math.max(0, 1 - s.eyesClosed) * (1 - Math.sin(Math.min(1, s.blink) * Math.PI) * 0.95);
      const wide = 1 + s.wide * 0.18;
      const spiralsOn = s.dizzy > 0.5;
      this.eyes.forEach((e, i) => {
        e.spiral.setAttribute("opacity", spiralsOn ? 1 : 0);
        e.spiral.setAttribute("transform", `rotate(${(s.t * 540 + i * 90) % 360})`);
        if (spiralsOn) { e.open.setAttribute("opacity", 0); e.closed.setAttribute("opacity", 0); e.brow.setAttribute("opacity", 0); return; }
        e.open.setAttribute("transform", `translate(${s.lookX} ${s.lookY}) scale(${wide} ${Math.max(0.05, openness * wide * (1 - s.angry * 0.3))})`);
        e.open.setAttribute("opacity", openness > 0.06 ? 1 : 0);
        e.closed.setAttribute("opacity", openness > 0.06 ? 0 : 1);
        e.brow.setAttribute("opacity", s.angry);
      });
      this.stars.forEach((star, i) => {
        const a = s.t * 4 + (i * Math.PI * 2) / 3;
        star.setAttribute("transform", `translate(${Math.cos(a) * 17} ${-25 + Math.sin(a) * 4}) scale(${0.8 + Math.sin(a) * 0.2})`);
        star.setAttribute("opacity", Math.max(0, s.dizzy * 1.4 - 0.4));
      });
      const content = Math.max(s.eyesClosed * s.sit, s.groom);
      this.blush.forEach((b) => b.setAttribute("opacity", 0.45 + content * 0.35));

      const talking = s.t < this.mouthUntil;
      s.mouth = ease(s.mouth, talking ? 1 : 0, 18, dt);
      this.mouthOpen.setAttribute("ry", Math.max(s.mouth * 3.4, s.yawn * 6.5));
      this.mouthOpen.setAttribute("rx", 3 + s.yawn * 1.8);
      this.mouthOpen.setAttribute("cy", 11.2 + s.yawn * 1.8);
      this.tongue.setAttribute("ry", s.groom * Math.max(0, lick) * 2.4 + s.yawn * 2);
      this.tongue.setAttribute("cy", 12.6 + s.yawn * 3);
      const w = Math.sin(s.t * 3) * 0.6;
      this.whiskers.setAttribute("d", `M-7 8 L-22 ${4.5 + w} M-7 10 L-22 ${11 + w} M9 8 L24 ${4.5 - w} M9 10 L24 ${11 - w}`);

      // --- tail: a chain whose joints ripple with a traveling sine wave ---
      const wrapped = Math.max(s.sit, s.loaf);
      let a0 = lerp(lerp(-2.25, -1.75, s.tailUp), 2.5, wrapped);
      let curl = lerp(lerp(moving ? 0.17 : 0.12, 0.03, s.tailUp), -0.33, wrapped);
      a0 = lerp(lerp(lerp(a0, -2.95, s.crouch), -1.85, s.bow), -3.0, airborne);
      curl = lerp(lerp(curl, 0.03, s.crouch), 0.01, airborne);
      const tailTarget = {
        a0, curl,
        sway: s.angry > 0.5 ? 0.2 : s.crouch > 0.5 ? 0.3 : wrapped > 0.5 ? 0.035 : moving ? 0.1 : 0.075,
        swayFreq: s.angry > 0.5 ? 9 : s.crouch > 0.5 ? 12 : moving ? 5 : 1.6,
      };
      for (const k in tailTarget) s[k] = ease(s[k], tailTarget[k], 5, dt);
      let [tx, ty] = at(-6, -16);
      tx -= s.loaf * 2; ty += s.loaf * 4;
      const pts = [[tx, ty]];
      let a = s.a0;
      for (let i = 1; i <= TAIL_SEGMENTS; i++) {
        a += s.curl + Math.sin(s.t * s.swayFreq - i * 0.55) * s.sway * (i / TAIL_SEGMENTS + 0.3);
        tx += Math.cos(a) * TAIL_SEG_LEN;
        ty = Math.min(GROUND - 3 + hop, ty + Math.sin(a) * TAIL_SEG_LEN);
        pts.push([tx, ty]);
      }
      const smooth = (p) => {
        let d = `M${p[0][0]} ${p[0][1]}`;
        for (let i = 1; i < p.length - 1; i++) {
          d += ` Q${p[i][0]} ${p[i][1]} ${(p[i][0] + p[i + 1][0]) / 2} ${(p[i][1] + p[i + 1][1]) / 2}`;
        }
        const l = p[p.length - 1];
        return `${d} L${l[0]} ${l[1]}`;
      };
      const width = 7.5 + s.puff * 6;
      const tailD = smooth(pts);
      this.tailFill.setAttribute("d", tailD);
      this.tailFill.setAttribute("stroke-width", width);
      this.tailOutline.setAttribute("d", tailD);
      this.tailOutline.setAttribute("stroke-width", width + 4.6);
      this.tailTip.setAttribute("d", smooth(pts.slice(-3)));
      this.tailTip.setAttribute("stroke-width", width - 0.5);

      // Shadow stays on the floor and shrinks while the cat is in the air.
      this.shadow.setAttribute("cx", lerp(78, 70, s.sit) + s.bow * 6);
      this.shadow.setAttribute("cy", GROUND + 1.5 + hop);
      this.shadow.setAttribute("rx", Math.max(14, 40 - s.stride * 0.6 - s.sit * 8 - hop * 0.25));
    }
  }

  window.Cat = Cat;
})();
