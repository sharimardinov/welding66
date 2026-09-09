/* <weld-viewer model="bracket|frame|ladder"> — rotating steel part, three.js (UMD r149). */
(() => {
  if (customElements.get('weld-viewer')) return;
  const T = () => window.THREE;

  const steel = () => new (T().MeshStandardMaterial)({ color: 0x8f8c8a, metalness: 0.6, roughness: 0.33 });
  const box = (w, h, d, x, y, z, mat) => {
    const m = new (T().Mesh)(new (T().BoxGeometry)(w, h, d), mat);
    m.position.set(x, y, z); return m;
  };
  const tube = (len, r, mat, axis) => {
    const m = new (T().Mesh)(new (T().CylinderGeometry)(r, r, len, 24), mat);
    if (axis === 'x') m.rotation.z = Math.PI / 2;
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    return m;
  };

  const builders = {
    // corner bracket: two plates + gusset
    bracket(mat) {
      const g = new (T().Group)();
      g.add(box(2.4, 0.16, 1.6, 0, 0, 0, mat));
      g.add(box(0.16, 1.8, 1.6, -1.12, 0.9, 0, mat));
      const gus = new (T().Mesh)(new (T().ExtrudeGeometry)(
        (() => { const s = new (T().Shape)(); s.moveTo(0, 0); s.lineTo(1.1, 0); s.lineTo(0, 1.3); s.lineTo(0, 0); return s; })(),
        { depth: 0.12, bevelEnabled: false }), mat);
      gus.position.set(-1.04, 0.08, -0.06);
      g.add(gus);
      [-0.5, 0.5].forEach((z) => [0.2, 1.4].forEach((x) => {
        const h = new (T().Mesh)(new (T().CylinderGeometry)(0.13, 0.13, 0.3, 16), mat);
        h.position.set(x - 0.6, 0, z); g.add(h);
      }));
      return g;
    },
    // welded frame from square tube
    frame(mat) {
      const g = new (T().Group)();
      const w = 2.6, h = 1.7, t = 0.16;
      g.add(box(w, t, t, 0, h / 2, 0, mat));
      g.add(box(w, t, t, 0, -h / 2, 0, mat));
      g.add(box(t, h, t, -w / 2 + t / 2, 0, 0, mat));
      g.add(box(t, h, t, w / 2 - t / 2, 0, 0, mat));
      g.add(box(w - t * 2, t, t, 0, 0, 0, mat));
      [-1, 1].forEach((s) => {
        const leg = box(t, 1.1, t, s * (w / 2 - t / 2), -h / 2 - 0.55, 0.55, mat);
        g.add(leg);
        g.add(box(t, 1.1, t, s * (w / 2 - t / 2), -h / 2 - 0.55, -0.55, mat));
      });
      g.add(box(w, t, t, 0, -h / 2 - 1.0, 0.55, mat));
      g.add(box(w, t, t, 0, -h / 2 - 1.0, -0.55, mat));
      g.position.y = 0.5;
      return g;
    },
    // ladder / railing: two rails + rungs
    ladder(mat) {
      const g = new (T().Group)();
      [-0.7, 0.7].forEach((x) => { const r = tube(3.2, 0.11, mat); r.position.set(x, 0, 0); g.add(r); });
      for (let i = -1.2; i <= 1.25; i += 0.8) {
        const r = tube(1.4, 0.075, mat, 'x'); r.position.set(0, i, 0); g.add(r);
      }
      g.add(box(1.7, 0.12, 0.5, 0, 1.66, 0.2, mat));
      return g;
    }
  };

  class WeldViewer extends HTMLElement {
    static get observedAttributes() { return ['model']; }
    connectedCallback() {
      if (this._init) return;
      this._init = true;
      this.style.display = 'block';
      this.style.cursor = 'grab';
      this._start();
    }
    attributeChangedCallback() { if (this._scene) this._swap(); }
    disconnectedCallback() {
      cancelAnimationFrame(this._raf);
      this._ro && this._ro.disconnect();
      this._renderer && this._renderer.dispose();
    }
    _swap() {
      const THREE = T();
      if (this._obj) { this._scene.remove(this._obj); }
      const name = this.getAttribute('model') || 'bracket';
      const build = builders[name] || builders.bracket;
      this._obj = build(this._mat);
      this._obj.rotation.y = this._yaw || -0.6;
      this._scene.add(this._obj);
      const bs = new THREE.Box3().setFromObject(this._obj).getBoundingSphere(new THREE.Sphere());
      this._camDist = bs.radius * 2.9;
      this._target = bs.center.clone();
      this._spawn = performance.now();
    }
    _start() {
      const THREE = T();
      if (!THREE) { setTimeout(() => this._start(), 60); return; }
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.domElement.style.display = 'block';
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      this.appendChild(renderer.domElement);
      this._renderer = renderer;

      const scene = new THREE.Scene();
      this._scene = scene;
      this._mat = steel();
      const cam = new THREE.PerspectiveCamera(38, 1, 0.1, 100);

      scene.add(new THREE.HemisphereLight(0xffffff, 0x8b8886, 0.85));
      const key = new THREE.DirectionalLight(0xffffff, 1.35); key.position.set(4, 6, 5); scene.add(key);
      const fill = new THREE.DirectionalLight(0xffffff, 0.55); fill.position.set(-5, 1, 3); scene.add(fill);
      const rim = new THREE.DirectionalLight(0xffffff, 0.7); rim.position.set(-2, 3, -6); scene.add(rim);

      this._yaw = -0.6; this._pitch = 0.32;
      this._swap();

      let dragging = false, px = 0, py = 0;
      const down = (e) => { dragging = true; px = e.clientX; py = e.clientY; this.style.cursor = 'grabbing'; };
      const move = (e) => {
        if (!dragging) return;
        this._yaw += (e.clientX - px) * 0.008;
        this._pitch = Math.max(-0.5, Math.min(0.9, this._pitch + (e.clientY - py) * 0.005));
        px = e.clientX; py = e.clientY;
      };
      const up = () => { dragging = false; this.style.cursor = 'grab'; };
      this.addEventListener('pointerdown', down);
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);

      const resize = () => {
        const r = this.getBoundingClientRect();
        const w = Math.round(r.width) || 400, h = Math.round(r.height) || 300;
        renderer.setSize(w, h, false);
        cam.aspect = w / h; cam.updateProjectionMatrix();
      };
      this._ro = new ResizeObserver(resize); this._ro.observe(this); resize();

      let prev = performance.now();
      const loop = (now) => {
        this._raf = requestAnimationFrame(loop);
        const dt = Math.min((now - prev) / 1000, 0.05); prev = now;
        if (!dragging) this._yaw += dt * 0.34;
        const t = Math.min((now - this._spawn) / 480, 1);
        const ease = 1 - Math.pow(1 - t, 3);
        if (this._obj) {
          this._obj.rotation.y = this._yaw;
          this._obj.rotation.x = this._pitch * 0.35;
          this._obj.scale.setScalar(0.92 + 0.08 * ease);
        }
        const d = this._camDist * (1.06 - 0.06 * ease);
        cam.position.set(Math.sin(0.9) * d * 0.5, this._target.y + d * 0.42, d * 0.86);
        cam.lookAt(this._target);
        renderer.render(scene, cam);
      };
      this._raf = requestAnimationFrame(loop);
    }
  }
  customElements.define('weld-viewer', WeldViewer);
})();
