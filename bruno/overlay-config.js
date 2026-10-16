// All editable settings, including the sprite's position, live here.
export const overlayConfig = {
  animations: [
    '/bruno-assets/animations/Bruno-Idle-01.html',
    '/bruno-assets/animations/Bruno-Idle-02.html',
    '/bruno-assets/animations/Bruno-Idle-03.html',
  ],
  duration: 2000,
  width: '200px',
  height: '300px', // 320:480 canvas ratio; artwork is contained if this changes.
  position: {
    // Left side, vertically centered, clear of the centered PROJECT / CHRONOS / THE AI GLITCH title stack.
    top: '50%', left: '24px', right: 'auto', bottom: 'auto',
    transform: 'translateY(-50%)',
  },
  zIndex: 9999,
  loadTimeout: 8000,
};
