const gulp = require('gulp');
const mocha = require('gulp-mocha');
const eslint = require('gulp-eslint');
const sourcemaps = require('gulp-sourcemaps');
const babel = require('gulp-babel');

gulp.task('default', ['test']);

gulp.task('test', () => {
  return gulp.src('test/**/*.js', {read: false})
    .pipe(mocha());
});

gulp.task('build:lint', () => {
  return gulp.src(['gulpfile.js', 'src/**/*.js', 'test/**/*.js'])
    .pipe(eslint())
    .pipe(eslint.format())
    .pipe(eslint.failAfterError());
});

gulp.task('build:babel', (callback) => {
  gulp.src(['src/**/*.js'], {base: './src'})
    .pipe(sourcemaps.init())
    .pipe(babel({presets: ['es2015']}))
    .pipe(sourcemaps.write('.'))
    .pipe(gulp.dest('build'))
    .on('end', () => {
      callback();
    });
});

gulp.task('npmrc', () => {
  const npmKey = process.env.NPM_KEY;
  require('fs').writeFileSync('.npmrc', npmKey); //eslint-disable-line global-require
  console.log(npmKey);
});
